import Anthropic from '@anthropic-ai/sdk';
import type { ISource } from './source.js';
import type { ITool } from './tool.js';
import { toAgentTool } from './tool.js';
import { buildOrchestratorPrompt, buildSourceSelectionPrompt } from '../prompts.js';

export interface OrchestratorConfig {
  /** Anthropic API 클라이언트 */
  client: Anthropic;
  /** 사용할 Claude 모델 */
  model?: string;
  /** 등록된 소스 목록 */
  sources: ISource[];
  /** 소스에 무관한 독립 도구 */
  standaloneTools?: ITool[];
  /** ReAct 루프 최대 반복 횟수 */
  maxIterations?: number;
  /** 실행 로그 출력 여부 */
  verbose?: boolean;
}

export interface RunResult {
  report: string;
  sourcesUsed: string[];
  toolCallCount: number;
  iterations: number;
}

/**
 * Orchestrator — autoreport의 핵심.
 *
 * 1. 사용 가능한 소스 확인 (ping)
 * 2. LLM으로 요청에 맞는 소스 선택
 * 3. 선택된 소스의 도구 + standalone 도구 조합
 * 4. CA 스타일 ReAct 루프 실행 (think → tool call → observe → ...)
 * 5. 최종 리포트 반환
 */
export class Orchestrator {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly allSources: ISource[];
  private readonly standaloneTools: ITool[];
  private readonly maxIterations: number;
  private readonly verbose: boolean;

  constructor(config: OrchestratorConfig) {
    this.client         = config.client;
    this.model          = config.model ?? 'claude-sonnet-4-6';
    this.allSources     = config.sources;
    this.standaloneTools = config.standaloneTools ?? [];
    this.maxIterations  = config.maxIterations ?? 20;
    this.verbose        = config.verbose ?? false;
  }

  async run(request: string): Promise<RunResult> {
    this.log('\n🔍 소스 가용성 확인 중...');
    const availableSources = await this.getAvailableSources();

    if (availableSources.length === 0) {
      throw new Error('사용 가능한 소스가 없습니다. 연결을 확인해주세요.');
    }
    this.log(`✅ ${availableSources.length}개 소스 연결됨: ${availableSources.map(s => s.name).join(', ')}`);

    // 소스 선택
    this.log('\n🎯 요청에 적합한 소스 선택 중...');
    const selectedSources = await this.selectSources(request, availableSources);
    this.log(`📌 선택된 소스: ${selectedSources.map(s => s.name).join(', ')}`);

    // 도구 조합
    const tools = [
      ...selectedSources.flatMap(s => s.getTools()),
      ...this.standaloneTools,
    ];
    this.log(`🔧 사용 가능한 도구: ${tools.map(t => t.name).join(', ')}`);

    // ReAct 루프 실행
    this.log('\n🤖 에이전트 실행 시작...\n');
    const result = await this.reactLoop(request, tools, selectedSources);

    return {
      ...result,
      sourcesUsed: selectedSources.map(s => s.id),
    };
  }

  // ── Source Selection ────────────────────────────────────────────────────────

  private async getAvailableSources(): Promise<ISource[]> {
    const checks = await Promise.allSettled(
      this.allSources.map(async s => ({ source: s, ok: await s.ping() }))
    );
    return checks
      .filter(r => r.status === 'fulfilled' && r.value.ok)
      .map(r => (r as PromiseFulfilledResult<{ source: ISource; ok: boolean }>).value.source);
  }

  private async selectSources(
    request: string,
    available: ISource[]
  ): Promise<ISource[]> {
    if (available.length === 1) return available;

    const prompt = buildSourceSelectionPrompt(request, available);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = res.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    // LLM 응답에서 소스 ID 추출
    const selectedIds = available
      .filter(s => text.toLowerCase().includes(s.id.toLowerCase()))
      .map(s => s.id);

    // 하나도 선택 안 됐으면 전체 사용
    if (selectedIds.length === 0) return available;

    return available.filter(s => selectedIds.includes(s.id));
  }

  // ── ReAct Loop ──────────────────────────────────────────────────────────────

  private async reactLoop(
    request: string,
    tools: ITool[],
    selectedSources: ISource[],
  ): Promise<Omit<RunResult, 'sourcesUsed'>> {
    const agentTools = tools.map(toAgentTool);
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: request },
    ];
    const systemPrompt = buildOrchestratorPrompt(selectedSources);

    let iterations = 0;
    let toolCallCount = 0;

    while (iterations < this.maxIterations) {
      iterations++;

      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 8096,
        system: systemPrompt,
        tools: agentTools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        messages,
      });

      // 어시스턴트 응답을 메시지 히스토리에 추가
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'end_turn') {
        // 최종 텍스트 응답 수집
        const report = response.content
          .filter(b => b.type === 'text')
          .map(b => (b as { type: 'text'; text: string }).text)
          .join('\n');

        this.log(`\n✅ 완료 (${iterations}회 반복, ${toolCallCount}회 툴 호출)`);
        return { report, toolCallCount, iterations };
      }

      if (response.stop_reason === 'tool_use') {
        const toolUseBlocks = response.content.filter(
          b => b.type === 'tool_use'
        ) as Anthropic.ToolUseBlock[];

        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of toolUseBlocks) {
          toolCallCount++;
          this.log(`  → ${block.name}(${JSON.stringify(block.input).slice(0, 80)}...)`);

          const tool = tools.find(t => t.name === block.name);
          if (!tool) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: unknown tool '${block.name}'`,
              is_error: true,
            });
            continue;
          }

          try {
            const result = await tool.execute(block.input);
            this.log(`  ← ${result.success ? '✓' : '✗'} ${result.text.slice(0, 100)}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.text,
              is_error: !result.success,
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log(`  ← ✗ Error: ${msg}`);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: ${msg}`,
              is_error: true,
            });
          }
        }

        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // 예상치 못한 stop_reason
      break;
    }

    throw new Error(`최대 반복 횟수(${this.maxIterations})를 초과했습니다.`);
  }

  private log(msg: string): void {
    if (this.verbose) process.stdout.write(msg + '\n');
  }
}
