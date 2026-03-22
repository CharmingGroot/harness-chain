/**
 * CA-based Orchestrator using AgentLoop + SubAgentTool + ToolDispatcher.
 * Sub-agents are instantiated from SubAgentDef registry and injected as tools
 * into the parent AgentLoop, enabling parallel delegation via ToolDispatcher.
 */
import { Registry, EventBus } from '@charming_groot/core';
import type { ITool as CATool, ILlmProvider, ProviderConfig } from '@charming_groot/core';
import { ClaudeProvider, OpenAIProvider } from '@charming_groot/providers';
import { AgentLoop, SubAgentTool } from '@charming_groot/agent';
import type { ISource, AnalyzeEvent, RunResult } from './types';
import { HarnessToolAdapter } from './ca-adapter';
import { listSubAgents } from './store';

// ── Provider factory ──────────────────────────────────────────────────────────

function resolveProvider(model: string, maxTokens: number): ILlmProvider {
  const isOpenAI = model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3');
  const config: ProviderConfig = {
    providerId: isOpenAI ? 'openai' : 'claude',
    model,
    auth: {
      type: 'api-key',
      apiKey: isOpenAI
        ? (process.env.OPENAI_API_KEY ?? '')
        : (process.env.ANTHROPIC_API_KEY ?? ''),
    },
    maxTokens,
    temperature: 0.7,
  };
  return isOpenAI ? new OpenAIProvider(config) : new ClaudeProvider(config);
}

export interface OrchestratorConfig {
  apiKey: string;
  sources: ISource[];
  model?: string;
  maxIterations?: number;
  onEvent?: (event: AnalyzeEvent) => void;
}

const SYSTEM_PROMPT = (sources: ISource[]) => `
당신은 하네스체인 — 데이터 분석 전문 오케스트레이터 에이전트입니다.

사용 가능한 데이터 소스:
${sources.map(s => `## ${s.name} (id: ${s.id})\n${s.description}`).join('\n\n')}

지침:
1. 분석 요청을 받으면 먼저 get_schema로 스키마를 파악하세요
2. 단계적으로 쿼리를 실행해 데이터를 수집하세요
3. 서브에이전트가 있다면 병렬로 위임하여 속도를 높이세요
4. 최종 리포트는 마크다운 형식으로, 다음 구조를 따르세요:
   - ## 요약
   - ## 주요 발견사항
   - ## 상세 분석
   - ## 인사이트 & 권고사항
`.trim();

export class Orchestrator {
  private readonly apiKey: string;
  private readonly sources: ISource[];
  private readonly model: string;
  private readonly maxIterations: number;
  private readonly onEvent: (event: AnalyzeEvent) => void;

  constructor(config: OrchestratorConfig) {
    this.apiKey = config.apiKey;
    this.sources = config.sources;
    this.model = config.model ?? 'claude-sonnet-4-6';
    this.maxIterations = config.maxIterations ?? 25;
    this.onEvent = config.onEvent ?? (() => {});
  }

  async run(request: string): Promise<RunResult> {
    this.emit({ type: 'source_check', message: '소스 연결 확인 중...' });

    const available = await this.getAvailableSources();
    if (available.length === 0) throw new Error('사용 가능한 소스가 없습니다.');

    this.emit({ type: 'source_selected', sources: available.map(s => s.name) });

    // Build tool registry from SQL tools + sub-agent tools
    const toolRegistry = new Registry<CATool>('tool');

    // Register SQL/source tools
    const harnessTools = available.flatMap(s => s.getTools());
    for (const tool of harnessTools) {
      toolRegistry.register(tool.name, new HarnessToolAdapter(tool));
    }

    // Register persisted sub-agents as SubAgentTools (parallel delegation)
    const subAgentDefs = listSubAgents();
    for (const def of subAgentDefs) {
      const subProvider = resolveProvider(def.model, 4096);

      const subToolRegistry = new Registry<CATool>('tool');
      for (const toolName of def.tools) {
        const t = toolRegistry.get(toolName);
        if (t) subToolRegistry.register(toolName, t);
      }

      const subAgentTool = new SubAgentTool({
        name: `subagent_${def.id}`,
        description: `${def.name}: ${def.description}`,
        provider: subProvider,
        toolRegistry: subToolRegistry,
        systemPrompt: def.systemPrompt,
        maxIterations: def.maxIterations,
      });

      toolRegistry.register(subAgentTool.name, subAgentTool);
    }

    const isOpenAI = this.model.startsWith('gpt-') || this.model.startsWith('o1') || this.model.startsWith('o3');
    const provider = resolveProvider(this.model, 8096);

    const eventBus = new EventBus();
    let toolCallCount = 0;

    eventBus.on('tool:start', (data: unknown) => {
      const { name, params } = data as { name: string; params: unknown };
      toolCallCount++;
      this.emit({ type: 'tool_call', tool: name, input: JSON.stringify(params).slice(0, 100) });
    });
    eventBus.on('tool:end', (data: unknown) => {
      const { name, result } = data as { name: string; result: { success: boolean; output: string } };
      this.emit({ type: 'tool_result', tool: name, success: result.success, preview: result.output.slice(0, 120) });
    });

    const agentLoop = new AgentLoop({
      provider,
      toolRegistry,
      config: {
        provider: {
          providerId: isOpenAI ? 'openai' : 'claude',
          model: this.model,
          auth: {
            type: 'api-key',
            apiKey: isOpenAI
              ? (process.env.OPENAI_API_KEY ?? '')
              : this.apiKey,
          },
          maxTokens: 8096,
          temperature: 0.7,
        },
        maxIterations: this.maxIterations,
        workingDirectory: process.cwd(),
        systemPrompt: SYSTEM_PROMPT(available),
      },
      eventBus,
    });

    const result = await agentLoop.run(request);

    return {
      report: result.content,
      sourcesUsed: available.map(s => s.id),
      toolCallCount,
      iterations: result.iterations,
    };
  }

  private async getAvailableSources(): Promise<ISource[]> {
    const checks = await Promise.allSettled(
      this.sources.map(async s => ({ source: s, ok: await s.ping() }))
    );
    return checks
      .filter(r => r.status === 'fulfilled' && r.value.ok)
      .map(r => (r as PromiseFulfilledResult<{ source: ISource; ok: boolean }>).value.source);
  }

  private emit(event: AnalyzeEvent): void {
    this.onEvent(event);
  }
}
