import { NextRequest, NextResponse } from 'next/server';
import { getHarness, updateHarness, deleteHarness, listRuns } from '@/lib/store';
import { scheduleHarness, unscheduleHarness } from '@/lib/executor';

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const harness = getHarness(id);
  if (!harness) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const runs = listRuns(id).slice(-10); // last 10 runs
  return NextResponse.json({ ...harness, runs });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const updated = updateHarness(id, body);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Update cron schedule if changed
  if (updated.schedule.type === 'cron') {
    scheduleHarness(id, updated.schedule.cron);
  } else {
    unscheduleHarness(id);
  }

  return NextResponse.json(updated);
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  unscheduleHarness(id);
  const ok = deleteHarness(id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
