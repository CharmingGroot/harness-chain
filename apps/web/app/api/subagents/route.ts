import { NextRequest, NextResponse } from 'next/server';
import { listSubAgents, saveSubAgent } from '@/lib/store';

export async function GET() {
  return NextResponse.json(listSubAgents());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, description, systemPrompt, tools = [], model = 'claude-sonnet-4-6', maxIterations = 25 } = body;
  if (!name || !systemPrompt) {
    return NextResponse.json({ error: 'name and systemPrompt required' }, { status: 400 });
  }
  const agent = saveSubAgent({ name, description: description ?? '', systemPrompt, tools, model, maxIterations });
  return NextResponse.json(agent, { status: 201 });
}
