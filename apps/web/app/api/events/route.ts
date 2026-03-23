/**
 * GET /api/events
 *
 * SSE 엔드포인트 — 루트 레이아웃에서 한 번 마운트.
 * Redis SUBSCRIBE hc:job:events → 클라이언트로 push.
 * navigation해도 레이아웃은 살아있으므로 커넥션 유지됨.
 */
import { NextResponse } from 'next/server';
import { getRedis } from '@/lib/redis';
import { EVENTS_CHANNEL_NAME } from '@/lib/job-queue';

export const dynamic = 'force-dynamic';

export async function GET() {
  // subscriber 전용 별도 클라이언트 (subscribe 상태에서 다른 명령 불가)
  const subscriber = getRedis().duplicate();

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();

      const send = (data: string) => {
        try {
          controller.enqueue(enc.encode(`data: ${data}\n\n`));
        } catch {
          // 클라이언트 이미 끊김
        }
      };

      // 연결 확인용 heartbeat (30초마다)
      const heartbeat = setInterval(() => send(':heartbeat'), 30_000);

      subscriber.subscribe(EVENTS_CHANNEL_NAME, (err) => {
        if (err) console.error('[sse] subscribe error:', err.message);
      });

      subscriber.on('message', (_channel: string, message: string) => {
        send(message);
      });

      subscriber.on('error', () => {
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* ignore */ }
      });

      // 스트림 닫힐 때 정리
      return () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe().catch(() => {});
        subscriber.quit().catch(() => {});
      };
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
