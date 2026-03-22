/**
 * File-based JSON store for harnesses, sub-agents, and run history.
 * Stored in /tmp/harness-chain/ (dev) or process.cwd()/data/ (prod).
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), 'data');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type Schedule = { type: 'once' } | { type: 'cron'; cron: string };

export interface SubAgentDef {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  skills?: string;       // markdown bullet list of what this agent can do
  rules?: string;        // markdown bullet list of constraints
  tools: string[];       // tool names available to this sub-agent
  model: string;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
}

export interface HarnessNode {
  id: string;
  kind: 'subagent' | 'tool' | 'source';
  ref: string;           // subAgentId, toolName, or sourceId
  label?: string;
}

export interface HarnessEdge {
  id: string;
  from: string;          // HarnessNode.id | '__start__'
  to: string;            // HarnessNode.id | '__end__'
  label?: string;        // 조건부 엣지 레이블 (예: "재검색", "종료")
  condition?: string;    // 분기 조건 설명
}

export interface HarnessDef {
  id: string;
  name: string;
  description: string;
  nodes: HarnessNode[];
  edges: HarnessEdge[];
  schedule: Schedule;
  createdAt: string;
  updatedAt: string;
}

/** Validate graph structure — returns error string or null */
export function validateHarnessGraph(
  nodes: HarnessNode[],
  edges: HarnessEdge[]
): string | null {
  if (!Array.isArray(nodes)) return 'nodes must be an array';
  if (!Array.isArray(edges)) return 'edges must be an array';

  for (const n of nodes) {
    if (!n.id || !n.kind || !n.ref) return `node missing id/kind/ref: ${JSON.stringify(n)}`;
    if (!['subagent', 'tool', 'source'].includes(n.kind)) return `invalid node kind: ${n.kind}`;
  }

  const validIds = new Set(['__start__', '__end__', ...nodes.map(n => n.id)]);
  for (const e of edges) {
    if (!e.id || !e.from || !e.to) return `edge missing id/from/to: ${JSON.stringify(e)}`;
    if (!validIds.has(e.from)) return `edge.from "${e.from}" references unknown node`;
    if (!validIds.has(e.to)) return `edge.to "${e.to}" references unknown node`;
    if (e.from === '__end__') return 'edges cannot originate from __end__';
    if (e.to === '__start__') return 'edges cannot point to __start__';
  }

  if (nodes.length > 0) {
    if (!edges.some(e => e.from === '__start__')) return '__start__ must have at least one outgoing edge';
    if (!edges.some(e => e.to === '__end__')) return 'at least one edge must point to __end__';
  }

  return null;
}

/** Migrate legacy steps-based harness to nodes+edges graph format */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateToGraph(raw: any): HarnessDef {
  if (Array.isArray(raw.nodes) && Array.isArray(raw.edges)) return raw as HarnessDef;
  // Legacy format: { steps: HarnessStep[] }
  const steps: HarnessNode[] = (raw.steps ?? []) as HarnessNode[];
  const nodes: HarnessNode[] = steps.map(s => ({ id: s.id, kind: s.kind, ref: s.ref, label: s.label }));
  const edges: HarnessEdge[] = [];
  if (steps.length > 0) {
    edges.push({ id: 'e___start__', from: '__start__', to: steps[0].id });
    for (let i = 0; i < steps.length - 1; i++) {
      edges.push({ id: `e_${i}`, from: steps[i].id, to: steps[i + 1].id });
    }
    edges.push({ id: 'e___end__', from: steps[steps.length - 1].id, to: '__end__' });
  }
  const { steps: _steps, ...rest } = raw;
  void _steps;
  return { ...rest, nodes, edges };
}

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface HarnessRun {
  id: string;
  harnessId: string;
  status: RunStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  report?: string;
  error?: string;
  meta?: { toolCallCount?: number; iterations?: number; sourcesUsed?: string[] };
}

// ── SubAgent store ────────────────────────────────────────────────────────────

const subAgentsFile = () => path.join(DATA_DIR, 'subagents.json');

export function listSubAgents(): SubAgentDef[] {
  return readJson<SubAgentDef[]>(subAgentsFile(), []);
}

export function getSubAgent(id: string): SubAgentDef | undefined {
  return listSubAgents().find(a => a.id === id);
}

export function saveSubAgent(def: Omit<SubAgentDef, 'id' | 'createdAt' | 'updatedAt'>): SubAgentDef {
  const agents = listSubAgents();
  const now = new Date().toISOString();
  const agent: SubAgentDef = { id: `sa_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...def, createdAt: now, updatedAt: now };
  writeJson(subAgentsFile(), [...agents, agent]);
  return agent;
}

export function updateSubAgent(id: string, patch: Partial<Omit<SubAgentDef, 'id' | 'createdAt'>>): SubAgentDef | null {
  const agents = listSubAgents();
  const idx = agents.findIndex(a => a.id === id);
  if (idx === -1) return null;
  const updated = { ...agents[idx], ...patch, updatedAt: new Date().toISOString() };
  agents[idx] = updated;
  writeJson(subAgentsFile(), agents);
  return updated;
}

export function deleteSubAgent(id: string): boolean {
  const agents = listSubAgents();
  const filtered = agents.filter(a => a.id !== id);
  if (filtered.length === agents.length) return false;
  writeJson(subAgentsFile(), filtered);
  return true;
}

// ── Harness store ─────────────────────────────────────────────────────────────

const harnessesFile = () => path.join(DATA_DIR, 'harnesses.json');

export function listHarnesses(): HarnessDef[] {
  const raw = readJson<unknown[]>(harnessesFile(), []);
  return raw.map(migrateToGraph);
}

export function getHarness(id: string): HarnessDef | undefined {
  return listHarnesses().find(h => h.id === id);
}

export function saveHarness(def: Omit<HarnessDef, 'id' | 'createdAt' | 'updatedAt'>): HarnessDef {
  const harnesses = listHarnesses();
  const now = new Date().toISOString();
  const harness: HarnessDef = { id: `h_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, ...def, createdAt: now, updatedAt: now };
  writeJson(harnessesFile(), [...harnesses, harness]);
  return harness;
}

export function updateHarness(id: string, patch: Partial<Omit<HarnessDef, 'id' | 'createdAt'>>): HarnessDef | null {
  const harnesses = listHarnesses();
  const idx = harnesses.findIndex(h => h.id === id);
  if (idx === -1) return null;
  const updated = { ...harnesses[idx], ...patch, updatedAt: new Date().toISOString() };
  harnesses[idx] = updated;
  writeJson(harnessesFile(), harnesses);
  return updated;
}

export function deleteHarness(id: string): boolean {
  const harnesses = listHarnesses();
  const filtered = harnesses.filter(h => h.id !== id);
  if (filtered.length === harnesses.length) return false;
  writeJson(harnessesFile(), filtered);
  return true;
}

// ── Run store ─────────────────────────────────────────────────────────────────

const runsFile = () => path.join(DATA_DIR, 'runs.json');

export function listRuns(harnessId?: string): HarnessRun[] {
  const runs = readJson<HarnessRun[]>(runsFile(), []);
  return harnessId ? runs.filter(r => r.harnessId === harnessId) : runs;
}

export function getRun(id: string): HarnessRun | undefined {
  return listRuns().find(r => r.id === id);
}

export function createRun(harnessId: string): HarnessRun {
  const runs = readJson<HarnessRun[]>(runsFile(), []);
  const run: HarnessRun = {
    id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    harnessId,
    status: 'pending',
    startedAt: new Date().toISOString(),
  };
  writeJson(runsFile(), [...runs, run]);
  return run;
}

export function updateRun(id: string, patch: Partial<HarnessRun>): HarnessRun | null {
  const runs = readJson<HarnessRun[]>(runsFile(), []);
  const idx = runs.findIndex(r => r.id === id);
  if (idx === -1) return null;
  const updated = { ...runs[idx], ...patch };
  runs[idx] = updated;
  writeJson(runsFile(), runs);
  return updated;
}
