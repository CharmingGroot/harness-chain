import { NextRequest } from 'next/server';
import { Orchestrator } from '@/lib/orchestrator';
import { createPgSandboxSource } from '@/lib/sources/postgresql';
import type { AnalyzeEvent } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5분

export async function POST(req: NextRequest) {
  const { query, model } = await req.json() as { query: string; model?: string };

  if (!query?.trim()) {
    return new Response(JSON.stringify({ error: 'query is required' }), { status: 400 });
  }

  const selectedModel = model ?? 'claude-sonnet-4-6';
  const isOpenAI = selectedModel.startsWith('gpt-') || selectedModel.startsWith('o1') || selectedModel.startsWith('o3');
  const apiKey = isOpenAI
    ? process.env.OPENAI_API_KEY
    : process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    const keyName = isOpenAI ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
    return new Response(JSON.stringify({ error: `${keyName} not configured` }), { status: 500 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: AnalyzeEvent) => {
        const data = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(data));
      };

      const source = createPgSandboxSource();
      try {
        const orchestrator = new Orchestrator({
          apiKey,
          model: selectedModel,
          sources: [source],
          maxIterations: 25,
          onEvent: send,
        });

        const result = await orchestrator.run(query);

        send({
          type: 'report',
          report: result.report,
          meta: {
            sourcesUsed: result.sourcesUsed,
            toolCallCount: result.toolCallCount,
            iterations: result.iterations,
          },
        });
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        await source.close();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
