/**
 * POST /api/harnesses/generate
 *
 * LLM-powered harness builder.
 * Single user prompt → internal multi-step pipeline:
 *   1. LLM generates nodes
 *   2. Validate nodes (kind/ref constraints)
 *   3. LLM generates edges (given nodes)
 *   4. validateHarnessGraph() — retry with error feedback if invalid
 * Returns: { name, description, nodes, edges }
 */
import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { validateHarnessGraph } from '@/lib/store';
import type { HarnessNode, HarnessEdge } from '@/lib/store';
import { listSubAgents } from '@/lib/store';

const SOURCES = ['pg-sandbox', 'mock-crm', 'mock-marketing', 'mock-external-api'];
const TOOLS = [
  'execute_query', 'explain_query', 'get_schema', 'get_table_sample', 'get_stats',
  'classify_risk', 'summarize_text', 'score_customer', 'generate_report', 'send_alert',
];

const MAX_RETRIES = 2;

export async function POST(req: NextRequest) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    return NextResponse.json({ error: 'API key not configured' }, { status: 503 });
  }

  const { prompt } = await req.json() as { prompt?: string };
  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  const subAgents = listSubAgents();
  const subAgentList = subAgents
    .map(a => `  - id: "${a.id}"  name: "${a.name}"  desc: "${a.description}"`)
    .join('\n') || '  (없음)';

  try {
    const result = await generateHarness(prompt.trim(), subAgentList, anthropicKey, openaiKey);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

// ── Generation pipeline ────────────────────────────────────────────────────────

async function generateHarness(
  userPrompt: string,
  subAgentList: string,
  anthropicKey?: string,
  openaiKey?: string,
) {
  const callLLM = anthropicKey
    ? makeAnthropicCall(anthropicKey)
    : makeOpenAICall(openaiKey!);

  const resourceContext = `
사용 가능한 리소스:
소스(source): ${SOURCES.join(', ')}
도구(tool): ${TOOLS.join(', ')}
서브에이전트(subagent):
${subAgentList}`;

  // ── Step 1: 노드 생성 ────────────────────────────────────────────────────────
  const nodesRaw = await callLLM(`
당신은 하네스 그래프 설계 전문가입니다. 사용자의 요청을 분석해 최적의 노드 목록을 설계하세요.

${resourceContext}

제약사항:
- kind는 반드시 "source", "tool", "subagent" 중 하나
- ref는 위 리소스 목록에서만 선택 (source → sources, tool → tools, subagent → id값)
- id는 n1, n2, n3... 형식
- label은 한국어로 역할 설명

사용자 요청: "${userPrompt}"

JSON 배열만 반환하세요 (설명 없이):
[{"id":"n1","kind":"source","ref":"pg-sandbox","label":"DB 조회"}, ...]`);

  const nodes = parseJSON<HarnessNode[]>(nodesRaw, []);

  // ── Step 2: 노드 검증 ────────────────────────────────────────────────────────
  const nodeError = validateNodes(nodes);
  if (nodeError) {
    throw new Error(`노드 검증 실패: ${nodeError}`);
  }

  // ── Step 3: 엣지 생성 (with retry on validation failure) ──────────────────
  let edges: HarnessEdge[] = [];
  let lastGraphError: string | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const retryContext = lastGraphError
      ? `\n이전 시도 오류: "${lastGraphError}"\n위 오류를 수정하여 다시 설계하세요.`
      : '';

    const edgesRaw = await callLLM(`
당신은 하네스 그래프 설계 전문가입니다. 아래 노드들을 연결하는 엣지를 설계하세요.

노드 목록:
${JSON.stringify(nodes, null, 2)}

규칙:
- from/to는 반드시 노드 id 또는 "__start__", "__end__" 사용
- __start__에서 시작하는 엣지가 반드시 1개 이상 필요
- __end__로 향하는 엣지가 반드시 1개 이상 필요
- 조건부 분기가 있으면 condition 필드에 조건 설명 추가
- 루프(back-edge)가 필요하면 포함 가능
- id는 e1, e2, e3... 형식${retryContext}

JSON 배열만 반환하세요 (설명 없이):
[{"id":"e1","from":"__start__","to":"n1"}, ...]`);

    edges = parseJSON<HarnessEdge[]>(edgesRaw, []);
    lastGraphError = validateHarnessGraph(nodes, edges);
    if (!lastGraphError) break;
  }

  if (lastGraphError) {
    throw new Error(`그래프 검증 실패: ${lastGraphError}`);
  }

  // ── Step 4: 하네스 이름 + 설명 생성 ─────────────────────────────────────────
  const metaRaw = await callLLM(`
아래 하네스에 어울리는 이름과 설명을 한국어로 생성하세요.

사용자 요청: "${userPrompt}"
노드: ${nodes.map(n => n.label ?? n.ref).join(' → ')}

JSON으로만 반환하세요:
{"name":"...", "description":"..."}`);

  const meta = parseJSON<{ name: string; description: string }>(metaRaw, {
    name: userPrompt.slice(0, 40),
    description: '',
  });

  return {
    name: meta.name || userPrompt.slice(0, 40),
    description: meta.description || '',
    nodes,
    edges,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateNodes(nodes: HarnessNode[]): string | null {
  if (!Array.isArray(nodes) || nodes.length === 0) return '노드가 없습니다';
  const validKinds = ['source', 'tool', 'subagent'];
  const allRefs = [...SOURCES, ...TOOLS];

  for (const n of nodes) {
    if (!n.id || !n.kind || !n.ref) return `노드 id/kind/ref 누락: ${JSON.stringify(n)}`;
    if (!validKinds.includes(n.kind)) return `잘못된 kind: ${n.kind}`;
    if (n.kind !== 'subagent' && !allRefs.includes(n.ref)) {
      return `알 수 없는 ref "${n.ref}" (kind: ${n.kind})`;
    }
  }
  return null;
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
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1024,
      }),
    });
    const data = await res.json() as { choices: { message: { content: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseJSON<T>(raw: string, fallback: T): T {
  // Extract JSON block from LLM response (may include markdown fences)
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  const text = match ? match[1] ?? match[0] : raw.trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
