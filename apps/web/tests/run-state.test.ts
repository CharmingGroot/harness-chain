/**
 * Tests for Redis-backed run state layer (run-state.ts)
 * Redis is fully mocked — tests focus on logic, not Redis internals.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock ioredis ──────────────────────────────────────────────────────────────

const { mockPipeline, mockRedis } = vi.hoisted(() => {
  const mockPipeline = {
    hset: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    sadd: vi.fn().mockReturnThis(),
    del: vi.fn().mockReturnThis(),
    srem: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([]),
  };
  const mockRedis = {
    pipeline: vi.fn().mockReturnValue(mockPipeline),
    smembers: vi.fn().mockResolvedValue([]),
    exists: vi.fn().mockResolvedValue(0),
  };
  return { mockPipeline, mockRedis };
});

vi.mock('../lib/redis', () => ({
  getRedis: vi.fn().mockReturnValue(mockRedis),
}));

import {
  markRunning,
  clearRunning,
  getActiveRunIds,
  isRunActive,
  recoverOrphanedRuns,
} from '../lib/run-state';
import { saveHarness, createRun } from '../lib/store';

beforeEach(() => {
  vi.clearAllMocks();
  mockPipeline.exec.mockResolvedValue([]);
  mockRedis.smembers.mockResolvedValue([]);
  mockRedis.exists.mockResolvedValue(0);
});

// ── markRunning ───────────────────────────────────────────────────────────────

describe('markRunning', () => {
  it('executes a Redis pipeline (hset + expire + sadd)', async () => {
    await markRunning('run_001', 'h_abc');

    expect(mockRedis.pipeline).toHaveBeenCalledOnce();
    expect(mockPipeline.hset).toHaveBeenCalledWith(
      'hc:run:run_001',
      expect.objectContaining({ harnessId: 'h_abc', status: 'running' })
    );
    expect(mockPipeline.expire).toHaveBeenCalledWith('hc:run:run_001', expect.any(Number));
    expect(mockPipeline.sadd).toHaveBeenCalledWith('hc:active', 'run_001');
    expect(mockPipeline.exec).toHaveBeenCalledOnce();
  });

  it('sets TTL of at least 1 minute', async () => {
    await markRunning('run_002', 'h_xyz');
    const [, ttl] = mockPipeline.expire.mock.calls[0];
    expect(ttl).toBeGreaterThanOrEqual(60);
  });

  it('does not throw when Redis is unavailable', async () => {
    mockRedis.pipeline.mockImplementationOnce(() => { throw new Error('ECONNREFUSED'); });
    await expect(markRunning('run_003', 'h_fail')).resolves.toBeUndefined();
  });
});

// ── clearRunning ──────────────────────────────────────────────────────────────

describe('clearRunning', () => {
  it('deletes the run key and removes from active set', async () => {
    await clearRunning('run_001');

    expect(mockPipeline.del).toHaveBeenCalledWith('hc:run:run_001');
    expect(mockPipeline.srem).toHaveBeenCalledWith('hc:active', 'run_001');
    expect(mockPipeline.exec).toHaveBeenCalledOnce();
  });

  it('does not throw when Redis is unavailable', async () => {
    mockRedis.pipeline.mockImplementationOnce(() => { throw new Error('ECONNREFUSED'); });
    await expect(clearRunning('run_fail')).resolves.toBeUndefined();
  });
});

// ── getActiveRunIds ───────────────────────────────────────────────────────────

describe('getActiveRunIds', () => {
  it('returns members of the active set', async () => {
    mockRedis.smembers.mockResolvedValueOnce(['run_1', 'run_2', 'run_3']);
    const ids = await getActiveRunIds();
    expect(ids).toEqual(['run_1', 'run_2', 'run_3']);
    expect(mockRedis.smembers).toHaveBeenCalledWith('hc:active');
  });

  it('returns empty array when set is empty', async () => {
    mockRedis.smembers.mockResolvedValueOnce([]);
    expect(await getActiveRunIds()).toEqual([]);
  });

  it('returns empty array when Redis is down', async () => {
    mockRedis.smembers.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await getActiveRunIds()).toEqual([]);
  });
});

// ── isRunActive ───────────────────────────────────────────────────────────────

describe('isRunActive', () => {
  it('returns true when key exists in Redis', async () => {
    mockRedis.exists.mockResolvedValueOnce(1);
    expect(await isRunActive('run_alive')).toBe(true);
    expect(mockRedis.exists).toHaveBeenCalledWith('hc:run:run_alive');
  });

  it('returns false when key does not exist', async () => {
    mockRedis.exists.mockResolvedValueOnce(0);
    expect(await isRunActive('run_gone')).toBe(false);
  });

  it('returns false when Redis is down', async () => {
    mockRedis.exists.mockRejectedValueOnce(new Error('timeout'));
    expect(await isRunActive('run_x')).toBe(false);
  });
});

// ── recoverOrphanedRuns ───────────────────────────────────────────────────────

describe('recoverOrphanedRuns', () => {
  it('returns 0 when there are no running runs in the file store', async () => {
    const count = await recoverOrphanedRuns();
    expect(count).toBe(0);
  });

  it('marks running-but-not-in-Redis runs as failed', async () => {
    const h = saveHarness({ name: '고아 런 테스트', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    // Simulate file store shows running
    const { updateRun } = await import('../lib/store');
    updateRun(run.id, { status: 'running' });

    // Redis says this run does NOT exist (expired / server restarted)
    mockRedis.exists.mockResolvedValueOnce(0);

    const count = await recoverOrphanedRuns();
    expect(count).toBe(1);

    const { getRun } = await import('../lib/store');
    const recovered = getRun(run.id);
    expect(recovered?.status).toBe('failed');
    expect(recovered?.error).toBeTruthy();
  });

  it('does NOT mark a run as failed if it is still active in Redis', async () => {
    const h = saveHarness({ name: '활성 런 테스트', description: '', steps: [], schedule: { type: 'once' } });
    const run = createRun(h.id);
    const { updateRun, getRun } = await import('../lib/store');
    updateRun(run.id, { status: 'running' });

    // Redis says run IS still alive
    mockRedis.exists.mockResolvedValueOnce(1);

    const count = await recoverOrphanedRuns();
    expect(count).toBe(0);

    expect(getRun(run.id)?.status).toBe('running');
  });

  it('recovers multiple orphans in one pass', async () => {
    const h = saveHarness({ name: '복수 고아 테스트', description: '', steps: [], schedule: { type: 'once' } });
    const { updateRun } = await import('../lib/store');
    const run1 = createRun(h.id);
    const run2 = createRun(h.id);
    const run3 = createRun(h.id);

    updateRun(run1.id, { status: 'running' });
    updateRun(run2.id, { status: 'running' });
    updateRun(run3.id, { status: 'running' });

    // run1 and run3 are orphaned; run2 is still alive
    mockRedis.exists
      .mockResolvedValueOnce(0)  // run1: gone
      .mockResolvedValueOnce(1)  // run2: alive
      .mockResolvedValueOnce(0); // run3: gone

    const count = await recoverOrphanedRuns();
    expect(count).toBe(2);
  });
});
