/**
 * Redis-backed job queue for background LLM tasks.
 *
 * Queue:   LPUSH / BRPOP  on  hc:job:queue
 * State:   HSET            on  hc:job:{jobId}
 * Pub/Sub: PUBLISH         on  hc:job:events
 * Cancel:  SET             on  hc:job:{jobId}:cancel
 */
import { getRedis } from './redis';

export type JobStep =
  | 'queued'
  | 'nodes'
  | 'validate_nodes'
  | 'edges'
  | 'validate_edges'
  | 'meta'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface JobState {
  jobId: string;
  prompt: string;
  step: JobStep;
  error?: string;
  result?: {
    name: string;
    description: string;
    nodes: unknown[];
    edges: unknown[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface JobEvent {
  jobId: string;
  step: JobStep;
  error?: string;
  result?: JobState['result'];
}

const QUEUE_KEY = 'hc:job:queue';
const EVENTS_CHANNEL = 'hc:job:events';
const JOB_TTL = 60 * 60 * 2; // 2시간

function jobKey(jobId: string) { return `hc:job:${jobId}`; }
function cancelKey(jobId: string) { return `hc:job:${jobId}:cancel`; }

// ── 생산자 ─────────────────────────────────────────────────────────────────────

export async function enqueueJob(prompt: string): Promise<string> {
  const jobId = `j_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = new Date().toISOString();
  const state: JobState = { jobId, prompt, step: 'queued', createdAt: now, updatedAt: now };

  const redis = getRedis();
  await redis.hset(jobKey(jobId), flattenState(state));
  await redis.expire(jobKey(jobId), JOB_TTL);
  await redis.lpush(QUEUE_KEY, jobId);

  return jobId;
}

// ── 소비자 ─────────────────────────────────────────────────────────────────────

/** 큐에서 jobId 하나를 꺼낸다. timeout=0이면 무한 대기. */
export async function dequeueJob(timeoutSec = 5): Promise<string | null> {
  const redis = getRedis();
  const result = await redis.brpop(QUEUE_KEY, timeoutSec);
  return result ? result[1] : null;
}

export async function getJobState(jobId: string): Promise<JobState | null> {
  const redis = getRedis();
  const raw = await redis.hgetall(jobKey(jobId));
  if (!raw || !raw.jobId) return null;
  return {
    jobId: raw.jobId,
    prompt: raw.prompt,
    step: raw.step as JobStep,
    error: raw.error || undefined,
    result: raw.result ? JSON.parse(raw.result) : undefined,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

export async function updateJobStep(jobId: string, step: JobStep, extra: Partial<Pick<JobState, 'error' | 'result'>> = {}): Promise<void> {
  const redis = getRedis();
  const patch: Record<string, string> = { step, updatedAt: new Date().toISOString() };
  if (extra.error) patch.error = extra.error;
  if (extra.result) patch.result = JSON.stringify(extra.result);

  await redis.hset(jobKey(jobId), patch);
  await redis.expire(jobKey(jobId), JOB_TTL);

  const event: JobEvent = { jobId, step, ...extra };
  await redis.publish(EVENTS_CHANNEL, JSON.stringify(event));
}

// ── 취소 ────────────────────────────────────────────────────────────────────────

export async function cancelJob(jobId: string): Promise<void> {
  const redis = getRedis();
  await redis.set(cancelKey(jobId), '1', 'EX', 3600);
}

export async function isCancelled(jobId: string): Promise<boolean> {
  const redis = getRedis();
  return (await redis.exists(cancelKey(jobId))) === 1;
}

// ── SSE 구독 ───────────────────────────────────────────────────────────────────

export const EVENTS_CHANNEL_NAME = EVENTS_CHANNEL;

// ── 헬퍼 ────────────────────────────────────────────────────────────────────────

function flattenState(s: JobState): Record<string, string> {
  return {
    jobId: s.jobId,
    prompt: s.prompt,
    step: s.step,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
