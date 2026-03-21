/**
 * Executor engine — runs harness templates immediately or on cron.
 *
 * State management:
 *   - file store: permanent audit record for all runs
 *   - Redis:       ephemeral "running" state with TTL (auto-cleans if server dies)
 */
import { Orchestrator } from './orchestrator';
import { createPgSandboxSource } from './sources/postgresql';
import { getHarness, createRun, updateRun } from './store';
import { markRunning, clearRunning } from './run-state';
import type { HarnessDef, HarnessRun } from './store';

// ── Immediate execution ───────────────────────────────────────────────────────

export async function executeHarness(
  harnessId: string,
  prompt?: string
): Promise<HarnessRun> {
  const harness = getHarness(harnessId);
  if (!harness) throw new Error(`Harness not found: ${harnessId}`);

  const run = createRun(harnessId);
  const startedAt = Date.now();

  // file store: running
  updateRun(run.id, { status: 'running' });
  // Redis: running + TTL (non-fatal if Redis is down)
  await markRunning(run.id, harnessId);

  const task = prompt ?? buildPromptFromHarness(harness);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const source = createPgSandboxSource();
  const orchestrator = new Orchestrator({
    apiKey,
    sources: [source],
    maxIterations: 30,
  });

  try {
    const result = await orchestrator.run(task);

    const updated = updateRun(run.id, {
      status: 'completed',
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      report: result.report,
      meta: {
        toolCallCount: result.toolCallCount,
        iterations: result.iterations,
        sourcesUsed: result.sourcesUsed,
      },
    });

    // Redis: remove from active set — terminal state is now in file store
    await clearRunning(run.id);
    return updated!;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    const updated = updateRun(run.id, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      error,
    });

    await clearRunning(run.id);
    return updated!;
  } finally {
    await source.close();
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPromptFromHarness(harness: HarnessDef): string {
  const stepDescs = harness.steps.map((step, i) => {
    if (step.kind === 'subagent') return `${i + 1}. 서브에이전트 '${step.ref}'에게 위임`;
    if (step.kind === 'tool') return `${i + 1}. 도구 '${step.ref}' 실행`;
    return `${i + 1}. 소스 '${step.ref}' 조회`;
  });

  return [
    `하네스 '${harness.name}'를 실행합니다.`,
    harness.description ? `목표: ${harness.description}` : '',
    '',
    '실행 단계:',
    ...stepDescs,
    '',
    '위 단계를 순서대로 실행하고 최종 리포트를 작성하세요.',
  ].filter(l => l !== undefined).join('\n');
}

// ── Cron scheduler (in-process) ───────────────────────────────────────────────

interface ScheduledJob {
  harnessId: string;
  cron: string;
  timer: ReturnType<typeof setInterval>;
}

const activeJobs = new Map<string, ScheduledJob>();

function cronToMs(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 60_000;
  const [minute, hour] = parts;
  if (minute === '*' && hour === '*') return 60_000;
  if (minute !== '*' && hour === '*') return 3_600_000;
  return 86_400_000;
}

export function scheduleHarness(harnessId: string, cron: string): void {
  if (activeJobs.has(harnessId)) unscheduleHarness(harnessId);
  const ms = cronToMs(cron);
  const timer = setInterval(() => {
    executeHarness(harnessId).catch(err =>
      console.error(`[executor] harness ${harnessId} failed:`, err)
    );
  }, ms);
  activeJobs.set(harnessId, { harnessId, cron, timer });
  console.log(`[executor] scheduled harness ${harnessId} every ${ms}ms (${cron})`);
}

export function unscheduleHarness(harnessId: string): void {
  const job = activeJobs.get(harnessId);
  if (job) {
    clearInterval(job.timer);
    activeJobs.delete(harnessId);
    console.log(`[executor] unscheduled harness ${harnessId}`);
  }
}

export function listScheduledJobs(): Array<{ harnessId: string; cron: string }> {
  return Array.from(activeJobs.values()).map(({ harnessId, cron }) => ({ harnessId, cron }));
}
