import { NextResponse } from 'next/server';
import { listRuns, listHarnesses } from '@/lib/store';
import { getActiveRunIds } from '@/lib/run-state';

export async function GET() {
  const harnesses = listHarnesses();
  const harnessMap = Object.fromEntries(harnesses.map(h => [h.id, h.name]));

  const allRuns = listRuns();

  // Active runIds from Redis — these are the ground truth for "running" state
  const activeInRedis = new Set(await getActiveRunIds());

  const jobs = allRuns
    .slice(-50)
    .reverse()
    .map(run => ({
      id: run.id,
      harnessId: run.harnessId,
      harnessName: harnessMap[run.harnessId] ?? run.harnessId,
      // If file store says running but Redis says gone → treat as failed (orphan)
      status: run.status === 'running' && !activeInRedis.has(run.id)
        ? 'failed'
        : run.status,
      trigger: 'manual',
      startedAt: run.startedAt,
      finishedAt: run.completedAt ?? null,
      durationMs: run.durationMs ?? null,
      error: run.status === 'running' && !activeInRedis.has(run.id)
        ? '서버 재시작으로 인해 중단됨'
        : (run.error ?? null),
      meta: run.meta ?? null,
    }));

  const metrics = {
    totalJobs: allRuns.length,
    // running: file store running AND confirmed in Redis
    running: allRuns.filter(r => r.status === 'running' && activeInRedis.has(r.id)).length,
    pending:   allRuns.filter(r => r.status === 'pending').length,
    completed: allRuns.filter(r => r.status === 'completed').length,
    failed:    allRuns.filter(r =>
      r.status === 'failed' || (r.status === 'running' && !activeInRedis.has(r.id))
    ).length,
    avgDurationMs: (() => {
      const done = allRuns.filter(r => r.durationMs != null);
      if (!done.length) return 0;
      return Math.round(done.reduce((s, r) => s + (r.durationMs ?? 0), 0) / done.length);
    })(),
  };

  return NextResponse.json({ jobs, metrics });
}
