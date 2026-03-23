/**
 * POST /api/harnesses/generate  — job 큐에 등록, jobId 즉시 반환
 * GET  /api/harnesses/generate?jobId=  — job 상태 조회
 * DELETE /api/harnesses/generate?jobId=  — job 취소
 */
import { NextRequest, NextResponse } from 'next/server';
import { enqueueJob, getJobState, cancelJob } from '@/lib/job-queue';

export async function POST(req: NextRequest) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!anthropicKey && !openaiKey) {
    return NextResponse.json({ error: 'API key not configured' }, { status: 503 });
  }

  const { prompt } = await req.json() as { prompt?: string };
  if (!prompt?.trim()) {
    return NextResponse.json({ error: 'prompt is required' }, { status: 400 });
  }

  const jobId = await enqueueJob(prompt.trim());
  return NextResponse.json({ jobId }, { status: 202 });
}

export async function GET(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

  const state = await getJobState(jobId);
  if (!state) return NextResponse.json({ error: 'job not found' }, { status: 404 });

  return NextResponse.json(state);
}

export async function DELETE(req: NextRequest) {
  const jobId = req.nextUrl.searchParams.get('jobId');
  if (!jobId) return NextResponse.json({ error: 'jobId required' }, { status: 400 });

  await cancelJob(jobId);
  return NextResponse.json({ cancelled: true });
}
