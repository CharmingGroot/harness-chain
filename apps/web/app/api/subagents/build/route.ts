import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { description } = await req.json() as { description?: string };

  if (!description?.trim()) {
    return new Response(JSON.stringify({ error: 'description is required' }), { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500 });
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        send({ type: 'thinking', text: '서브에이전트 설계 중...' });

        const msg = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 2000,
          messages: [{
            role: 'user',
            content: `다음 설명을 바탕으로 AI 서브에이전트를 설계해줘:\n\n${description}\n\n아래 JSON 형식으로만 응답해줘 (설명 없이 JSON만):\n{\n  "name": "에이전트 이름 (짧고 명확하게, 한글 또는 snake_case 영문)",\n  "description": "에이전트 한 줄 설명",\n  "systemPrompt": "에이전트의 핵심 역할과 행동 방식. 도메인 전문성, 분석 접근법, 출력 형식 등을 포함해서 구체적으로 작성 (3-6문장)",\n  "skills": "이 에이전트가 할 수 있는 것들을 마크다운 불릿 리스트로 (4-7개)",\n  "rules": "이 에이전트가 반드시 지켜야 할 제약/금지사항을 마크다운 불릿 리스트로 (3-5개)"\n}`,
          }],
        });

        const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('AI가 유효한 응답을 생성하지 못했습니다');

        const data = JSON.parse(jsonMatch[0]);
        send({ type: 'result', data });
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
}
