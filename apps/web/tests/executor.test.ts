/**
 * Tests for harness executor (mocked orchestrator)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveHarness, listRuns } from '../lib/store';

// Module-level mock fn so individual tests can override it
const mockRun = vi.fn().mockResolvedValue({
  report: '## 요약\n모의 분석 완료',
  sourcesUsed: ['pg-sandbox'],
  toolCallCount: 3,
  iterations: 2,
});

vi.mock('../lib/orchestrator', () => ({
  Orchestrator: class {
    run = mockRun;
  },
}));

vi.mock('../lib/sources/postgresql', () => ({
  createPgSandboxSource: vi.fn().mockReturnValue({
    ping: vi.fn().mockResolvedValue(true),
    close: vi.fn().mockResolvedValue(undefined),
    getTools: vi.fn().mockReturnValue([]),
    name: 'pg-sandbox',
    id: 'pg-sandbox',
    description: 'Mock PG',
  }),
}));

import { executeHarness, scheduleHarness, unscheduleHarness, listScheduledJobs } from '../lib/executor';

describe('executeHarness', () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockRun.mockResolvedValue({
      report: '## 요약\n모의 분석 완료',
      sourcesUsed: ['pg-sandbox'],
      toolCallCount: 3,
      iterations: 2,
    });
  });

  it('runs a harness and returns completed run', async () => {
    const h = saveHarness({
      name: '데이터 분석 하네스',
      description: '트랜잭션 분석',
      steps: [{ id: 's1', kind: 'tool', ref: 'execute_query' }],
      schedule: { type: 'once' },
    });

    const run = await executeHarness(h.id);
    expect(run.status).toBe('completed');
    expect(run.report).toContain('요약');
    expect(run.durationMs).toBeGreaterThanOrEqual(0);
    expect(run.meta?.sourcesUsed).toContain('pg-sandbox');
  });

  it('records run in the store after execution', async () => {
    const h = saveHarness({
      name: '스토어 기록 테스트',
      description: '',
      steps: [],
      schedule: { type: 'once' },
    });

    await executeHarness(h.id);
    const runs = listRuns(h.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('completed');
  });

  it('marks run as failed when orchestrator throws', async () => {
    mockRun.mockRejectedValueOnce(new Error('DB 연결 실패'));

    const h = saveHarness({
      name: '실패 시나리오',
      description: '오케스트레이터 오류',
      steps: [],
      schedule: { type: 'once' },
    });

    const run = await executeHarness(h.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('DB 연결 실패');
  });

  it('throws when harness does not exist', async () => {
    await expect(executeHarness('h_nonexistent')).rejects.toThrow('Harness not found');
  });

  it('uses custom prompt when provided', async () => {
    const h = saveHarness({
      name: '커스텀 프롬프트 테스트',
      description: '',
      steps: [],
      schedule: { type: 'once' },
    });

    const customPrompt = 'VIP 고객 이탈 위험 분석을 해줘';
    await executeHarness(h.id, customPrompt);
    expect(mockRun).toHaveBeenCalledWith(customPrompt);
  });

  it('stores toolCallCount and iterations in run meta', async () => {
    const h = saveHarness({
      name: 'meta 확인 테스트',
      description: '',
      steps: [],
      schedule: { type: 'once' },
    });

    const run = await executeHarness(h.id);
    expect(run.meta?.toolCallCount).toBe(3);
    expect(run.meta?.iterations).toBe(2);
  });
});

describe('scheduleHarness / unscheduleHarness', () => {
  it('schedules and unschedules a harness', () => {
    scheduleHarness('h_test_sched', '0 9 * * *');
    const jobs = listScheduledJobs();
    expect(jobs.some(j => j.harnessId === 'h_test_sched')).toBe(true);
    unscheduleHarness('h_test_sched');
    expect(listScheduledJobs().some(j => j.harnessId === 'h_test_sched')).toBe(false);
  });

  it('replaces existing schedule when rescheduled', () => {
    scheduleHarness('h_reschedule', '* * * * *');
    scheduleHarness('h_reschedule', '0 9 * * *');
    const jobs = listScheduledJobs().filter(j => j.harnessId === 'h_reschedule');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].cron).toBe('0 9 * * *');
    unscheduleHarness('h_reschedule');
  });

  it('silently ignores unscheduling non-existent harness', () => {
    expect(() => unscheduleHarness('h_never_scheduled')).not.toThrow();
  });
});
