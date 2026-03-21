import { NextRequest, NextResponse } from 'next/server';
import { getSubAgent, updateSubAgent, deleteSubAgent } from '@/lib/store';

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = getSubAgent(id);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(agent);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const updated = updateSubAgent(id, body);
  if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ok = deleteSubAgent(id);
  if (!ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
