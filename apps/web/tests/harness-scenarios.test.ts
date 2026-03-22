/**
 * Harness scenario tests — creates realistic harnesses and validates them
 */
import { describe, it, expect } from 'vitest';
import {
  saveHarness, listHarnesses, getHarness, updateHarness, deleteHarness,
  saveSubAgent, createRun, updateRun, listRuns,
} from '../lib/store';

function makeLinear(steps: { id: string; kind: 'source' | 'tool' | 'subagent'; ref: string; label?: string }[]) {
  const nodes = steps;
  const edges = steps.length === 0 ? [] : [
    { id: 'e_s', from: '__start__', to: steps[0].id },
    ...steps.slice(0, -1).map((s, i) => ({ id: `e_${i}`, from: s.id, to: steps[i + 1].id })),
    { id: 'e_e', from: steps[steps.length - 1].id, to: '__end__' },
  ];
  return { nodes, edges };
}

const SCENARIOS = [
  {
    name: 'VIP 이탈 위험 일일 리포트',
    description: '매일 오전 9시 VIP 고객 이탈 위험 분석',
    ...makeLinear([
      { id: 's1', kind: 'source' as const, ref: 'pg-sandbox', label: 'DB 조회' },
      { id: 's2', kind: 'tool' as const, ref: 'execute_query', label: 'VIP 이탈 쿼리' },
      { id: 's3', kind: 'tool' as const, ref: 'get_schema', label: '스키마 확인' },
    ]),
    schedule: { type: 'cron' as const, cron: '0 9 * * *' },
  },
  {
    name: '이상 거래 탐지 보고서',
    description: '비정상 거래 패턴 및 사기 의심 거래 식별',
    ...makeLinear([
      { id: 's1', kind: 'tool' as const, ref: 'execute_query', label: '이상 거래 탐지 쿼리' },
      { id: 's2', kind: 'tool' as const, ref: 'explain_query', label: '쿼리 성능 분석' },
    ]),
    schedule: { type: 'cron' as const, cron: '0 */6 * * *' },
  },
  {
    name: 'DB 쿼리 성능 최적화 보고서',
    description: '인덱스 사용률 및 슬로우 쿼리 분석',
    ...makeLinear([
      { id: 's1', kind: 'tool' as const, ref: 'get_stats', label: 'DB 통계 조회' },
      { id: 's2', kind: 'tool' as const, ref: 'explain_query', label: 'EXPLAIN 분석' },
      { id: 's3', kind: 'tool' as const, ref: 'get_schema', label: '인덱스 현황' },
    ]),
    schedule: { type: 'once' as const },
  },
  {
    name: '대출 부실 위험 주간 분석',
    description: '대출 연체 현황 및 충당금 권고',
    ...makeLinear([
      { id: 's1', kind: 'tool' as const, ref: 'execute_query', label: '연체 대출 조회' },
      { id: 's2', kind: 'tool' as const, ref: 'get_table_sample', label: '대출 샘플' },
    ]),
    schedule: { type: 'cron' as const, cron: '0 8 * * 1' },
  },
  {
    name: '투자 포트폴리오 손익 월간 분석',
    description: '자산 유형별 수익률 및 손익 현황',
    ...makeLinear([
      { id: 's1', kind: 'tool' as const, ref: 'execute_query', label: '포트폴리오 조회' },
      { id: 's2', kind: 'tool' as const, ref: 'execute_query', label: '손익 계산' },
    ]),
    schedule: { type: 'cron' as const, cron: '0 9 1 * *' },
  },
];

describe('Harness scenarios — creation', () => {
  it('creates all 5 financial analysis harnesses', () => {
    for (const scenario of SCENARIOS) {
      saveHarness(scenario);
    }
    expect(listHarnesses()).toHaveLength(SCENARIOS.length);
  });

  it('each harness has unique id', () => {
    const ids = SCENARIOS.map(s => saveHarness(s).id);
    const unique = new Set(ids);
    expect(unique.size).toBe(SCENARIOS.length);
  });

  it('harnesses with cron schedule have cron expression', () => {
    const cronHarnesses = SCENARIOS.filter(s => s.schedule.type === 'cron');
    for (const def of cronHarnesses) {
      const h = saveHarness(def);
      expect(h.schedule.type).toBe('cron');
      if (h.schedule.type === 'cron') {
        expect(h.schedule.cron).toBeTruthy();
      }
    }
  });

  it('harness nodes are preserved correctly', () => {
    const h = saveHarness(SCENARIOS[0]);
    const loaded = getHarness(h.id);
    expect(loaded?.nodes).toHaveLength(3);
    expect(loaded?.nodes[0].kind).toBe('source');
    expect(loaded?.nodes[1].kind).toBe('tool');
  });
});

describe('Harness scenarios — lifecycle', () => {
  it('harness can be updated with new nodes after creation', () => {
    const h = saveHarness(SCENARIOS[2]);
    const newNode = { id: 's4', kind: 'tool' as const, ref: 'get_table_sample', label: '신규 단계' };
    // Remove the old __end__ edge and re-route: s3→s4→__end__
    const updatedEdges = [
      ...h.edges.filter(e => e.to !== '__end__'),
      { id: 'e_new', from: 's3', to: 's4' },
      { id: 'e_end', from: 's4', to: '__end__' },
    ];
    const updated = updateHarness(h.id, { nodes: [...h.nodes, newNode], edges: updatedEdges });
    expect(updated?.nodes).toHaveLength(4);
  });

  it('harness schedule can be changed from once to cron', () => {
    const h = saveHarness({ ...SCENARIOS[2], schedule: { type: 'once' } });
    const updated = updateHarness(h.id, { schedule: { type: 'cron', cron: '0 0 * * *' } });
    expect(updated?.schedule.type).toBe('cron');
  });

  it('harness can be deleted and is gone from list', () => {
    const h = saveHarness(SCENARIOS[0]);
    const id = h.id;
    deleteHarness(id);
    expect(getHarness(id)).toBeUndefined();
    expect(listHarnesses().find(x => x.id === id)).toBeUndefined();
  });

  it('deleting one harness does not affect others', () => {
    const h1 = saveHarness(SCENARIOS[0]);
    const h2 = saveHarness(SCENARIOS[1]);
    const h3 = saveHarness(SCENARIOS[2]);
    deleteHarness(h2.id);
    const remaining = listHarnesses();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(h => h.id)).toContain(h1.id);
    expect(remaining.map(h => h.id)).toContain(h3.id);
  });
});

describe('Harness scenarios — run history', () => {
  it('harness accumulates multiple run records', () => {
    const h = saveHarness(SCENARIOS[0]);
    createRun(h.id);
    createRun(h.id);
    createRun(h.id);
    expect(listRuns(h.id)).toHaveLength(3);
  });

  it('run transitions: pending → running → completed', () => {
    const h = saveHarness(SCENARIOS[1]);
    const run = createRun(h.id);
    expect(run.status).toBe('pending');

    updateRun(run.id, { status: 'running' });
    expect(listRuns(h.id)[0].status).toBe('running');

    updateRun(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      durationMs: 2340,
      report: '## 이상 거래 탐지 결과\n총 127건의 이상 거래 탐지됨.',
      meta: { toolCallCount: 8, iterations: 4, sourcesUsed: ['pg-sandbox'] },
    });
    const final = listRuns(h.id)[0];
    expect(final.status).toBe('completed');
    expect(final.meta?.toolCallCount).toBe(8);
  });

  it('run transition: pending → running → failed', () => {
    const h = saveHarness(SCENARIOS[2]);
    const run = createRun(h.id);
    updateRun(run.id, { status: 'running' });
    updateRun(run.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      durationMs: 500,
      error: 'pg-sandbox 연결 실패: ECONNREFUSED',
    });
    const final = listRuns(h.id)[0];
    expect(final.status).toBe('failed');
    expect(final.error).toContain('ECONNREFUSED');
  });
});

describe('SubAgent + Harness integration', () => {
  it('creates subagent and references it in harness steps', () => {
    const agent = saveSubAgent({
      name: 'churn_analyzer',
      description: 'VIP 고객 이탈 분석 전문 에이전트',
      systemPrompt: '당신은 금융 고객 이탈 분석 전문가입니다. VIP 고객의 거래 패턴을 분석하여 이탈 위험을 평가하세요.',
      tools: ['execute_query', 'get_schema', 'get_table_sample'],
      model: 'claude-sonnet-4-6',
      maxIterations: 25,
    });

    const h = saveHarness({
      name: 'VIP 이탈 분석 (에이전트 기반)',
      description: '서브에이전트가 VIP 이탈 위험 분석 전담',
      ...makeLinear([{ id: 's1', kind: 'subagent', ref: agent.id, label: 'churn_analyzer' }]),
      schedule: { type: 'once' },
    });

    expect(h.nodes[0].ref).toBe(agent.id);
    expect(getHarness(h.id)?.nodes[0].kind).toBe('subagent');
  });

  it('creates multi-subagent harness with parallel analysis', () => {
    const fraudAgent = saveSubAgent({
      name: 'fraud_detector',
      description: '이상 거래 탐지 에이전트',
      systemPrompt: '거래 패턴을 분석하여 사기 의심 거래를 탐지합니다.',
      tools: ['execute_query', 'get_stats'],
      model: 'claude-sonnet-4-6',
      maxIterations: 20,
    });

    const reportAgent = saveSubAgent({
      name: 'report_writer',
      description: '분석 결과 보고서 작성 에이전트',
      systemPrompt: '분석 결과를 바탕으로 경영진 보고서를 작성합니다.',
      tools: ['execute_query'],
      model: 'claude-sonnet-4-6',
      maxIterations: 10,
    });

    const h = saveHarness({
      name: '금융 통합 분석 파이프라인',
      description: '이상 거래 탐지 + 보고서 생성 파이프라인',
      ...makeLinear([
        { id: 's1', kind: 'subagent', ref: fraudAgent.id, label: '이상 거래 탐지' },
        { id: 's2', kind: 'subagent', ref: reportAgent.id, label: '보고서 작성' },
      ]),
      schedule: { type: 'cron', cron: '0 6 * * *' },
    });

    expect(h.nodes).toHaveLength(2);
    expect(h.nodes[0].ref).toBe(fraudAgent.id);
    expect(h.nodes[1].ref).toBe(reportAgent.id);
  });
});
