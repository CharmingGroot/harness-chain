import { NextRequest, NextResponse } from 'next/server';
import { listHarnesses, saveHarness } from '@/lib/store';

export async function GET() {
  return NextResponse.json(listHarnesses());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, description, steps = [], schedule = { type: 'once' } } = body;
  if (!name) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  const harness = saveHarness({ name, description: description ?? '', steps, schedule });
  return NextResponse.json(harness, { status: 201 });
}
