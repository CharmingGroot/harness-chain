import { NextRequest, NextResponse } from 'next/server';
import { listHarnesses, saveHarness, validateHarnessGraph } from '@/lib/store';
import type { HarnessNode, HarnessEdge } from '@/lib/store';

export async function GET() {
  return NextResponse.json(listHarnesses());
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    name,
    description,
    nodes = [] as HarnessNode[],
    edges = [] as HarnessEdge[],
    schedule = { type: 'once' },
  } = body as {
    name?: string;
    description?: string;
    nodes?: HarnessNode[];
    edges?: HarnessEdge[];
    schedule?: unknown;
  };

  if (!name?.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  const graphError = validateHarnessGraph(nodes, edges);
  if (graphError) {
    return NextResponse.json({ error: `invalid graph: ${graphError}` }, { status: 400 });
  }

  const harness = saveHarness({
    name: name.trim(),
    description: description?.trim() ?? '',
    nodes,
    edges,
    schedule: schedule as { type: 'once' } | { type: 'cron'; cron: string },
  });
  return NextResponse.json(harness, { status: 201 });
}
