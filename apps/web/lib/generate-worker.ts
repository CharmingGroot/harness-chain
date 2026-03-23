/**
 * Background worker — harness generation pipeline.
 * Called by instrumentation.ts worker loop.
 *
 * Steps: nodes → validate_nodes → edges → validate_edges → meta → done
 * 각 단계마다 Redis job state를 갱신하고 SSE 이벤트를 publish한다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { validateHarnessGraph, listSubAgents } from './store';
import type { HarnessNode, HarnessEdge } from './store';
import { updateJobStep, isCancelled } from './job-queue';

const SOURCES = ['pg-sandbox', 'mock-crm', 'mock-marketing', 'mock-external-api'];
const TOOLS = [
  'execute_query', 'explain_query', 'get_schema', 'get_table_sample', 'get_stats',
  'classify_risk', 'summarize_text', 'score_customer', 'generate_report', 'send_alert',
];
const MAX_RETRIES = 2;

export async function runGenerateJob(jobId: string, prompt: string): Promise<void> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const callLLM = anthropicKey ? makeAnthropicCall(anthropicKey) : makeOpenAICall(openaiKey!);

  const subAgents = listSubAgents();
  const subAgentList = subAgents
    .map(a => `  - id: "${a.id}"  name: "${a.name}"  desc: "${a.description}"`)
    .join('\n') || '  (없음)';

  const resourceContext = `사용 가능한 리소스:
소스(source): ${SOURCES.join(', ')}
도구(tool): ${TOOLS.join(', ')}
서브에이전트(subagent):
${subAgentList}`;

  try {
    // ── 1. 노드 설계 ──────────────────────────────────────────────────────────
    await updateJobStep(jobId, 'nodes');
    if (await isCancelled(jobId)) return await updateJobStep(jobId, 'cancelled');

    const nodesRaw = await callLLM(`당신은 하네스 그래프 설계 전문가입니다. 사용자의 요청을 분석해 최적의 노드 목록을 설계하세요.

${resourceContext}

제약사항:
- kind는 반드시 "source", "tool", "subagent" 중 하나
- ref는 위 리소스 목록에서만 선택 (source → sources, tool → tools, subagent → id값)
- id는 n1, n2, n3... 형식
- label은 한국어로 역할 설명

사용자 요청: "${prompt}"

JSON 배열만 반환하세요 (설명 없이):
[{"id":"n1","kind":"source","ref":"pg-sandbox","label":"DB 조회"}, ...]`);

    const nodes = parseJSON<HarnessNode[]>(nodesRaw, []);

    // ── 2. 노드 검증 ──────────────────────────────────────────────────────────
    await updateJobStep(jobId, 'validate_nodes');
    if (await isCancelled(jobId)) return await updateJobStep(jobId, 'cancelled');

    const nodeError = validateNodes(nodes);
    if (nodeError) return await updateJobStep(jobId, 'failed', { error: `노드 검증 실패: ${nodeError}` });

    // ── 3. 엣지 설계 (실패 시 재시도) ────────────────────────────────────────
    await updateJobStep(jobId, 'edges');
    if (await isCancelled(jobId)) return await updateJobStep(jobId, 'cancelled');

    let edges: HarnessEdge[] = [];
    let lastGraphError: string | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const retryCtx = lastGraphError ? `\n이전 시도 오류: "${lastGraphError}"\n위 오류를 수정하여 다시 설계하세요.` : '';

      const edgesRaw = await callLLM(`당신은 하네스 그래프 설계 전문가입니다. 아래 노드들을 연결하는 엣지를 설계하세요.

노드 목록:
${JSON.stringify(nodes, null, 2)}

규칙:
- from/to는 반드시 노드 id 또는 "__start__", "__end__" 사용
- __start__에서 시작하는 엣지가 반드시 1개 이상 필요
- __end__로 향하는 엣지가 반드시 1개 이상 필요
- 조건부 분기가 있으면 condition 필드에 조건 설명 추가
- id는 e1, e2, e3... 형식${retryCtx}

JSON 배열만 반환하세요 (설명 없이):
[{"id":"e1","from":"__start__","to":"n1"}, ...]`);

      edges = parseJSON<HarnessEdge[]>(edgesRaw, []);

      // ── 4. 그래프 검증 ────────────────────────────────────────────────────
      await updateJobStep(jobId, 'validate_edges');
      if (await isCancelled(jobId)) return await updateJobStep(jobId, 'cancelled');

      lastGraphError = validateHarnessGraph(nodes, edges);
      if (!lastGraphError) break;
      if (attempt < MAX_RETRIES) await updateJobStep(jobId, 'edges'); // 재시도 알림
    }

    if (lastGraphError) return await updateJobStep(jobId, 'failed', { error: `그래프 검증 실패: ${lastGraphError}` });

    // ── 5. 이름·설명 생성 ─────────────────────────────────────────────────────
    await updateJobStep(jobId, 'meta');
    if (await isCancelled(jobId)) return await updateJobStep(jobId, 'cancelled');

    const metaRaw = await callLLM(`아래 하네스에 어울리는 이름과 설명을 한국어로 생성하세요.

사용자 요청: "${prompt}"
노드: ${nodes.map(n => n.label ?? n.ref).join(' → ')}

JSON으로만 반환하세요:
{"name":"...", "description":"..."}`);

    const meta = parseJSON<{ name: string; description: string }>(metaRaw, { name: prompt.slice(0, 40), description: '' });

    await updateJobStep(jobId, 'done', {
      result: {
        name: meta.name || prompt.slice(0, 40),
        description: meta.description || '',
        nodes,
        edges,
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await updateJobStep(jobId, 'failed', { error }).catch(() => {});
  }
}

// ── LLM adapters ──────────────────────────────────────────────────────────────

function makeAnthropicCall(apiKey: string) {
  const client = new Anthropic({ apiKey });
  return async (prompt: string): Promise<string> => {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const block = msg.content[0];
    return block.type === 'text' ? block.text : '';
  };
}

function makeOpenAICall(apiKey: string) {
  return async (prompt: string): Promise<string> => {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
    });
    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateNodes(nodes: HarnessNode[]): string | null {
  if (!Array.isArray(nodes) || nodes.length === 0) return '노드가 없습니다';
  const allRefs = [...SOURCES, ...TOOLS];
  for (const n of nodes) {
    if (!n.id || !n.kind || !n.ref) return `노드 id/kind/ref 누락: ${JSON.stringify(n)}`;
    if (!['source', 'tool', 'subagent'].includes(n.kind)) return `잘못된 kind: ${n.kind}`;
    if (n.kind !== 'subagent' && !allRefs.includes(n.ref)) return `알 수 없는 ref "${n.ref}" (kind: ${n.kind})`;
  }
  return null;
}

function parseJSON<T>(raw: string, fallback: T): T {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  const text = match ? match[1] ?? match[0] : raw.trim();
  try { return JSON.parse(text) as T; } catch { return fallback; }
}
