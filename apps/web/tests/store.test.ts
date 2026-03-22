/**
 * Tests for file-based JSON store (harnesses, subagents, runs)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  listHarnesses, saveHarness, getHarness, updateHarness, deleteHarness,
  listSubAgents, saveSubAgent, getSubAgent, updateSubAgent, deleteSubAgent,
  listRuns, createRun, getRun, updateRun,
} from '../lib/store';

// ── Harness CRUD ──────────────────────────────────────────────────────────────

describe('Harness store', () => {
  it('starts empty', () => {
    expect(listHarnesses()).toEqual([]);
  });

  it('saves and retrieves a harness', () => {
    const h = saveHarness({
      name: 'Test Harness',
      description: '테스트용',
      steps: [],
      schedule: { type: 'once' },
    });
    expect(h.id).toMatch(/^h_/);
    expect(h.name).toBe('Test Harness');
    expect(listHarnesses()).toHaveLength(1);
    expect(getHarness(h.id)).toMatchObject({ name: 'Test Harness' });
  });

  it('saves harness with steps', () => {
    const h = saveHarness({
      name: '단계 하네스',
      description: '단계 포함',
      steps: [
        { id: 's1', kind: 'tool', ref: 'execute_query', label: 'SQL 실행' },
        { id: 's2', kind: 'subagent', ref: 'sa_001', label: '분석 에이전트' },
      ],
      schedule: { type: 'once' },
    });
    expect(h.steps).toHaveLength(2);
    expect(h.steps[0].kind).toBe('tool');
    expect(h.steps[1].kind).toBe('subagent');
  });

  it('saves harness with cron schedule', () => {
    const h = saveHarness({
      name: '일일 리포트',
      description: '매일 실행',
      steps: [],
      schedule: { type: 'cron', cron: '0 9 * * *' },
    });
    expect(h.schedule.type).toBe('cron');
    if (h.schedule.type === 'cron') {
      expect(h.schedule.cron).toBe('0 9 * * *');
    }
  });

  it('updates a harness', () => {
    const h = saveHarness({ name: '원본', description: '', steps: [], schedule: { type: 'once' } });
    const updated = updateHarness(h.id, { name: '수정됨', description: '업데이트됨' });
    expect(updated?.name).toBe('수정됨');
    expect(updated?.description).toBe('업데이트됨');
    expect(getHarness(h.id)?.name).toBe('수정됨');
  });

  it('returns null when updating non-existent harness', () => {
    expect(updateHarness('h_nonexistent', { name: '없음' })).toBeNull();
  });

  it('deletes a harness', () => {
    const h = saveHarness({ name: '삭제 대상', description: '', steps: [], schedule: { type: 'once' } });
    expect(deleteHarness(h.id)).toBe(true);
    expect(listHarnesses()).toHaveLength(0);
    expect(getHarness(h.id)).toBeUndefined();
  });

  it('returns false when deleting non-existent harness', () => {
    expect(deleteHarness('h_ghost')).toBe(false);
  });

  it('maintains multiple harnesses independently', () => {
    saveHarness({ name: 'A', description: '', steps: [], schedule: { type: 'once' } });
    saveHarness({ name: 'B', description: '', steps: [], schedule: { type: 'once' } });
    saveHarness({ name: 'C', description: '', steps: [], schedule: { type: 'once' } });
    const all = listHarnesses();
    expect(all).toHaveLength(3);
    expect(all.map(h => h.name)).toEqual(['A', 'B', 'C']);
  });

  it('persists createdAt and updatedAt', () => {
    const h = saveHarness({ name: '타임스탬프', description: '', steps: [], schedule: { type: 'once' } });
    expect(h.createdAt).toBeTruthy();
    expect(h.updatedAt).toBeTruthy();
    expect(new Date(h.createdAt).getTime()).toBeLessThanOrEqual(Date.now());
  });
});

// ── SubAgent CRUD ─────────────────────────────────────────────────────────────

describe('SubAgent store', () => {
  it('starts empty', () => {
    expect(listSubAgents()).toEqual([]);
  });

  it('saves and retrieves a sub-agent', () => {
    const a = saveSubAgent({
      name: 'churn_analyzer',
      description: 'VIP 이탈 분석',
      systemPrompt: '당신은 고객 이탈 분석 전문가입니다.',
      tools: ['execute_query', 'get_schema'],
      model: 'claude-sonnet-4-6',
      maxIterations: 20,
    });
    expect(a.id).toMatch(/^sa_/);
    expect(a.name).toBe('churn_analyzer');
    expect(a.tools).toContain('execute_query');
    expect(getSubAgent(a.id)).toMatchObject({ name: 'churn_analyzer' });
  });

  it('updates sub-agent tools list', () => {
    const a = saveSubAgent({
      name: 'agent_a',
      description: '',
      systemPrompt: 'test',
      tools: ['execute_query'],
      model: 'claude-sonnet-4-6',
      maxIterations: 10,
    });
    const updated = updateSubAgent(a.id, { tools: ['execute_query', 'get_schema', 'get_stats'] });
    expect(updated?.tools).toHaveLength(3);
  });

  it('deletes a sub-agent', () => {
    const a = saveSubAgent({ name: 'to_delete', description: '', systemPrompt: 'x', tools: [], model: 'claude-sonnet-4-6', maxIterations: 5 });
    expect(deleteSubAgent(a.id)).toBe(true);
    expect(listSubAgents()).toHaveLength(0);
  });

  it('returns false when deleting non-existent sub-agent', () => {
    expect(deleteSubAgent('sa_ghost')).toBe(false);
  });
});

  it('deleteSubAgent returns false for non-existent id', () => {
    expect(deleteSubAgent('sa_nonexistent')).toBe(false);
  });

  it('getSubAgent returns undefined for non-existent id', () => {
    expect(getSubAgent('sa_ghost')).toBeUndefined();
  });

  it('updateSubAgent returns null for non-existent id', () => {
    expect(updateSubAgent('sa_ghost', { name: '없음' })).toBeNull();
  });

  it('saves subagent with all fields', () => {
    const a = saveSubAgent({
      name: '전체 필드 테스트',
      description: '설명',
      systemPrompt: '시스템 프롬프트',
      tools: ['execute_query', 'get_schema'],
      model: 'claude-sonnet-4-6',
      maxIterations: 15,
    });
    expect(a.id).toMatch(/^sa_/);
    expect(a.model).toBe('claude-sonnet-4-6');
    expect(a.maxIterations).toBe(15);
    expect(a.createdAt).toBeTruthy();
    expect(a.updatedAt).toBeTruthy();
  });

// ── Run store ─────────────────────────────────────────────────────────────────

describe('Run store', () => {
  it('creates a run with pending status', () => {
    const h = saveHarness({ name: '런 테스트', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    expect(run.id).toMatch(/^run_/);
    expect(run.harnessId).toBe(h.id);
    expect(run.status).toBe('pending');
    expect(run.startedAt).toBeTruthy();
  });

  it('updates run status to running', () => {
    const h = saveHarness({ name: '런 상태', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    const updated = updateRun(run.id, { status: 'running' });
    expect(updated?.status).toBe('running');
  });

  it('completes a run with report', () => {
    const h = saveHarness({ name: '완료 런', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    const now = new Date().toISOString();
    const completed = updateRun(run.id, {
      status: 'completed',
      completedAt: now,
      durationMs: 1500,
      report: '## 요약\n분석이 완료되었습니다.',
      meta: { toolCallCount: 5, iterations: 3, sourcesUsed: ['pg-sandbox'] },
    });
    expect(completed?.status).toBe('completed');
    expect(completed?.report).toContain('요약');
    expect(completed?.meta?.toolCallCount).toBe(5);
  });

  it('marks run as failed with error', () => {
    const h = saveHarness({ name: '실패 런', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    const failed = updateRun(run.id, { status: 'failed', error: '소스 연결 실패' });
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toBe('소스 연결 실패');
  });

  it('filters runs by harness id', () => {
    const h1 = saveHarness({ name: 'H1', description: '', steps: [], schedule: { type: 'once' } });
    const h2 = saveHarness({ name: 'H2', description: '', steps: [], schedule: { type: 'once' } });
    createRun(h1.id);
    createRun(h1.id);
    createRun(h2.id);
    expect(listRuns(h1.id)).toHaveLength(2);
    expect(listRuns(h2.id)).toHaveLength(1);
    expect(listRuns()).toHaveLength(3);
  });

  it('retrieves run by id', () => {
    const h = saveHarness({ name: '조회 테스트', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    expect(getRun(run.id)).toMatchObject({ id: run.id });
    expect(getRun('run_nonexistent')).toBeUndefined();
  });

  it('updateRun returns null for non-existent run id', () => {
    expect(updateRun('run_ghost', { status: 'completed' })).toBeNull();
  });

  it('run id format starts with run_', () => {
    const h = saveHarness({ name: 'ID 포맷', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    expect(run.id).toMatch(/^run_/);
  });

  it('listRuns with no filter returns all runs across harnesses', () => {
    const h1 = saveHarness({ name: 'H1', description: '', steps: [], schedule: { type: 'once' } });
    const h2 = saveHarness({ name: 'H2', description: '', steps: [], schedule: { type: 'once' } });
    createRun(h1.id);
    createRun(h2.id);
    expect(listRuns()).toHaveLength(2);
  });

  it('run has startedAt timestamp in ISO format', () => {
    const h = saveHarness({ name: '타임스탬프 런', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    expect(run.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('run durationMs is set after update', () => {
    const h = saveHarness({ name: '소요시간 테스트', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    const updated = updateRun(run.id, { status: 'completed', durationMs: 4200, completedAt: new Date().toISOString() });
    expect(updated?.durationMs).toBe(4200);
  });
});
