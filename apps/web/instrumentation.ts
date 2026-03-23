/**
 * Next.js instrumentation hook — runs once on server startup (Node.js runtime only).
 *
 * 1. 고아 run 복구 (Redis 없는 running → failed)
 * 2. 하네스 생성 job worker 루프 시작 (Redis BRPOP)
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { recoverOrphanedRuns } = await import('./lib/run-state');
  await recoverOrphanedRuns();

  // worker 루프 — 별도 await 없이 백그라운드로 실행
  startGenerateWorker();
}

async function startGenerateWorker() {
  const { dequeueJob, getJobState, updateJobStep } = await import('./lib/job-queue');
  const { runGenerateJob } = await import('./lib/generate-worker');

  console.log('[worker] harness generate worker started');

  while (true) {
    try {
      const jobId = await dequeueJob(5); // 5초 대기 후 재시도
      if (!jobId) continue;

      const state = await getJobState(jobId);
      if (!state) continue;

      // 이미 완료/취소된 job은 건너뜀
      if (['done', 'failed', 'cancelled'].includes(state.step)) continue;

      console.log(`[worker] processing job ${jobId}: "${state.prompt.slice(0, 40)}..."`);
      await runGenerateJob(jobId, state.prompt);
      console.log(`[worker] job ${jobId} finished`);
    } catch (err) {
      // worker가 죽으면 안 되므로 에러 로그만
      console.error('[worker] error:', err instanceof Error ? err.message : err);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}
