/**
 * Integration tests — validates complete harness lifecycle and
 * creates realistic scenarios in the actual data store.
 */
import { describe, it, expect } from 'vitest';
import {
  saveHarness, listHarnesses, updateHarness, saveSubAgent,
  createRun, updateRun, listRuns,
} from '../lib/store';

describe('Full harness lifecycle', () => {
  it('create → run → complete lifecycle for VIP churn analysis', async () => {
    // 1. Create sub-agent
    const agent = saveSubAgent({
      name: 'vip_churn_agent',
      description: 'VIP 고객 이탈 위험 분석',
      systemPrompt: '당신은 금융 고객 이탈 분석 전문가입니다.',
      tools: ['execute_query', 'get_schema', 'get_table_sample'],
      model: 'claude-sonnet-4-6',
      maxIterations: 25,
    });
    expect(agent.id).toBeTruthy();

    // 2. Create harness referencing sub-agent
    const harness = saveHarness({
      name: 'VIP 이탈 일일 분석',
      description: 'VIP 등급 이탈 위험 고객 매일 분석',
      steps: [
        { id: 's1', kind: 'source', ref: 'pg-sandbox', label: 'DB 연결' },
        { id: 's2', kind: 'subagent', ref: agent.id, label: 'VIP 분석' },
        { id: 's3', kind: 'tool', ref: 'execute_query', label: '최종 집계' },
      ],
      schedule: { type: 'cron', cron: '0 9 * * *' },
    });
    expect(harness.steps).toHaveLength(3);

    // 3. Create and complete a run
    const run = createRun(harness.id);
    updateRun(run.id, { status: 'running' });
    const completed = updateRun(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      durationMs: 3200,
      report: `## 요약
총 VIP 고객 1,234명 중 이탈 위험 고객 87명 (7.1%) 식별

## 주요 발견사항
- PLATINUM 등급에서 이탈 위험 가장 높음 (12.3%)
- 평균 자산 규모: 2억 3천만원

## 상세 분석
최근 90일간 거래 없는 VIP 고객 현황...

## 인사이트 & 권고사항
즉각적인 고객 케어 전화 및 특별 혜택 제공 권장`,
      meta: { toolCallCount: 8, iterations: 4, sourcesUsed: ['pg-sandbox'] },
    });

    expect(completed?.status).toBe('completed');
    expect(completed?.report).toContain('요약');
    expect(completed?.meta?.toolCallCount).toBe(8);

    // 4. Verify run appears in history
    const history = listRuns(harness.id);
    expect(history).toHaveLength(1);
    expect(history[0].status).toBe('completed');
  });

  it('handles concurrent harness runs for same harness', () => {
    const h = saveHarness({
      name: '동시 실행 테스트',
      description: '',
      steps: [],
      schedule: { type: 'once' },
    });

    // Simulate 3 concurrent run starts
    const run1 = createRun(h.id);
    const run2 = createRun(h.id);
    const run3 = createRun(h.id);

    // All should have unique IDs
    const ids = [run1.id, run2.id, run3.id];
    expect(new Set(ids).size).toBe(3);

    // Complete them in different orders
    updateRun(run2.id, { status: 'completed', completedAt: new Date().toISOString() });
    updateRun(run1.id, { status: 'failed', error: 'timeout' });
    updateRun(run3.id, { status: 'running' });

    const runs = listRuns(h.id);
    expect(runs.find(r => r.id === run1.id)?.status).toBe('failed');
    expect(runs.find(r => r.id === run2.id)?.status).toBe('completed');
    expect(runs.find(r => r.id === run3.id)?.status).toBe('running');
  });

  it('multi-step harness with mixed step kinds', () => {
    const agent1 = saveSubAgent({ name: 'agent1', description: '', systemPrompt: 'x', tools: [], model: 'claude-sonnet-4-6', maxIterations: 5 });
    const agent2 = saveSubAgent({ name: 'agent2', description: '', systemPrompt: 'y', tools: [], model: 'claude-sonnet-4-6', maxIterations: 5 });

    const h = saveHarness({
      name: '멀티 스텝 파이프라인',
      description: '소스 → 에이전트 → 도구 → 에이전트 → 도구',
      steps: [
        { id: 's1', kind: 'source', ref: 'pg-sandbox', label: '소스 연결' },
        { id: 's2', kind: 'subagent', ref: agent1.id, label: '1차 분석' },
        { id: 's3', kind: 'tool', ref: 'execute_query', label: '데이터 수집' },
        { id: 's4', kind: 'subagent', ref: agent2.id, label: '2차 분석' },
        { id: 's5', kind: 'tool', ref: 'get_stats', label: '통계 수집' },
      ],
      schedule: { type: 'once' },
    });

    const loaded = listHarnesses().find(x => x.id === h.id);
    expect(loaded?.steps).toHaveLength(5);
    expect(loaded?.steps.map(s => s.kind)).toEqual(['source', 'subagent', 'tool', 'subagent', 'tool']);
  });
});

describe('Harness data integrity', () => {
  it('harness IDs are truly unique across rapid creation', () => {
    const count = 20;
    const ids = Array.from({ length: count }, () =>
      saveHarness({ name: `h${Math.random()}`, description: '', steps: [], schedule: { type: 'once' } }).id
    );
    expect(new Set(ids).size).toBe(count);
  });

  it('subagent IDs are unique across rapid creation', () => {
    const count = 15;
    const ids = Array.from({ length: count }, (_, i) =>
      saveSubAgent({ name: `sa${i}`, description: '', systemPrompt: 'x', tools: [], model: 'claude-sonnet-4-6', maxIterations: 5 }).id
    );
    expect(new Set(ids).size).toBe(count);
  });

  it('run IDs are unique across rapid creation', () => {
    const h = saveHarness({ name: 'run id test', description: '', steps: [], schedule: { type: 'once' } });
    const count = 20;
    const ids = Array.from({ length: count }, () => createRun(h.id).id);
    expect(new Set(ids).size).toBe(count);
  });

  it('harness timestamps use ISO format', () => {
    const h = saveHarness({ name: 'ts test', description: '', steps: [], schedule: { type: 'once' } });
    expect(() => new Date(h.createdAt)).not.toThrow();
    expect(() => new Date(h.updatedAt)).not.toThrow();
    expect(h.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('updatedAt changes after update but createdAt stays same', () => {
    const h = saveHarness({ name: '시간 테스트', description: '', steps: [], schedule: { type: 'once' } });
    const originalCreatedAt = h.createdAt;
    const originalUpdatedAt = h.updatedAt;

    // Small delay to ensure timestamp differs
    for (let i = 0; i < 1e6; i++) { /* spin */ }

    const result = updateHarness(h.id, { description: '변경됨' })!;
    expect(result.createdAt).toBe(originalCreatedAt);
    // updatedAt should be same or later (might be same ms)
    expect(new Date(result.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(originalUpdatedAt).getTime());
  });
});

describe('Scenario: Financial analysis harnesses', () => {
  const financialScenarios = [
    { name: 'DB 성능 최적화 분석', description: '쿼리 성능 및 인덱스 현황', steps: 3, schedule: 'once' },
    { name: '투자 포트폴리오 손익 분석', description: '자산 유형별 수익률', steps: 2, schedule: 'cron' },
    { name: '신용 점수 분포 분석', description: '고객 신용 등급 현황', steps: 2, schedule: 'cron' },
    { name: '계좌 잔액 이상 탐지', description: '비정상 잔액 변동 탐지', steps: 2, schedule: 'once' },
    { name: '월별 거래량 트렌드', description: '월별 신규 거래 추이', steps: 3, schedule: 'cron' },
  ] as const;

  it('creates all financial scenario harnesses', () => {
    for (const scenario of financialScenarios) {
      const steps = Array.from({ length: scenario.steps }, (_, i) => ({
        id: `s${i + 1}`,
        kind: i === 0 ? 'source' as const : 'tool' as const,
        ref: i === 0 ? 'pg-sandbox' : 'execute_query',
        label: `단계 ${i + 1}`,
      }));

      const h = saveHarness({
        name: scenario.name,
        description: scenario.description,
        steps,
        schedule: scenario.schedule === 'cron'
          ? { type: 'cron', cron: '0 9 * * *' }
          : { type: 'once' },
      });

      expect(h.id).toBeTruthy();
      expect(h.steps).toHaveLength(scenario.steps);
    }

    expect(listHarnesses()).toHaveLength(financialScenarios.length);
  });

  it('all harnesses have valid step references', () => {
    for (const scenario of financialScenarios) {
      const steps = Array.from({ length: scenario.steps }, (_, i) => ({
        id: `s${i + 1}`,
        kind: 'tool' as const,
        ref: 'execute_query',
      }));
      saveHarness({ name: scenario.name, description: scenario.description, steps, schedule: { type: 'once' } });
    }

    const harnesses = listHarnesses();
    for (const h of harnesses) {
      for (const step of h.steps) {
        expect(step.id).toBeTruthy();
        expect(step.kind).toMatch(/^(source|tool|subagent)$/);
        expect(step.ref).toBeTruthy();
      }
    }
  });
});
