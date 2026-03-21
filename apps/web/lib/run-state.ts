/**
 * Redis-backed run state layer.
 *
 * Responsibility split:
 *   Redis  → live "running" state, TTL-based auto-cleanup, fast status lookup
 *   file store → permanent audit record (all terminal states: completed/failed)
 *
 * Key schema:
 *   hc:run:{runId}          Hash  — { harnessId, status, startedAt }   TTL=RUN_TTL_SEC
 *   hc:active               Set   — runIds currently in "running" state
 */
import { getRedis } from './redis';

const RUN_TTL_SEC = 30 * 60; // 30 minutes — if a run hasn't finished in 30m, it's stuck
const KEY = (runId: string) => `hc:run:${runId}`;
const ACTIVE_SET = 'hc:active';

export interface RunStateEntry {
  runId: string;
  harnessId: string;
  status: 'running';
  startedAt: string;
}

/** Mark a run as running in Redis. Sets TTL so stale runs auto-expire. */
export async function markRunning(runId: string, harnessId: string): Promise<void> {
  try {
    const redis = getRedis();
    const pipeline = redis.pipeline();
    pipeline.hset(KEY(runId), {
      harnessId,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    pipeline.expire(KEY(runId), RUN_TTL_SEC);
    pipeline.sadd(ACTIVE_SET, runId);
    await pipeline.exec();
  } catch {
    // Redis failure is non-fatal — executor continues via file store
  }
}

/** Remove a run from Redis once it reaches a terminal state (completed/failed). */
export async function clearRunning(runId: string): Promise<void> {
  try {
    const redis = getRedis();
    const pipeline = redis.pipeline();
    pipeline.del(KEY(runId));
    pipeline.srem(ACTIVE_SET, runId);
    await pipeline.exec();
  } catch { /* non-fatal */ }
}

/** Return all currently running runIds tracked in Redis. */
export async function getActiveRunIds(): Promise<string[]> {
  try {
    const redis = getRedis();
    return await redis.smembers(ACTIVE_SET);
  } catch {
    return [];
  }
}

/** Check if a specific runId is still tracked as running in Redis. */
export async function isRunActive(runId: string): Promise<boolean> {
  try {
    const redis = getRedis();
    return (await redis.exists(KEY(runId))) === 1;
  } catch {
    return false;
  }
}

/**
 * Startup recovery: find all runs that are "running" in the file store
 * but no longer tracked in Redis (server restarted mid-run) and mark them failed.
 */
export async function recoverOrphanedRuns(): Promise<number> {
  const { listRuns, updateRun } = await import('./store');

  const runningInStore = listRuns().filter(r => r.status === 'running');
  if (runningInStore.length === 0) return 0;

  let recovered = 0;
  for (const run of runningInStore) {
    const alive = await isRunActive(run.id);
    if (!alive) {
      updateRun(run.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: '서버 재시작으로 인해 중단됨',
      });
      recovered++;
    }
  }

  if (recovered > 0) {
    console.log(`[run-state] recovered ${recovered} orphaned run(s) → marked failed`);
  }
  return recovered;
}
