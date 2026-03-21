/**
 * Next.js instrumentation hook — runs once on server startup.
 * Recovers runs that were "running" when the server last died.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { recoverOrphanedRuns } = await import('./lib/run-state');
    await recoverOrphanedRuns();
  }
}
