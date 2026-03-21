import { NextRequest, NextResponse } from 'next/server';
import { executeHarness } from '@/lib/executor';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const { prompt } = body as { prompt?: string };

  try {
    // Fire and forget — return run metadata immediately, execution continues in background
    const runPromise = executeHarness(id, prompt);

    // Return the initial run record (status=running)
    const run = await Promise.race([
      runPromise.then(r => r),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 200)),
    ]).catch(() => {
      // Still running — return pending info
      return { id: `run_pending`, harnessId: id, status: 'running', startedAt: new Date().toISOString() };
    });

    return NextResponse.json(run, { status: 202 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
