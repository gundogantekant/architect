import { NextRequest } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { streamConversationResponse } from '@/lib/streaming';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthenticatedUser();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const convCheck = await query(
    `SELECT id FROM conversations WHERE id = $1 AND user_sub = $2`,
    [params.id, user.sub]
  );
  if (convCheck.rows.length === 0) {
    return new Response('Not found', { status: 404 });
  }

  const { signal } = req;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamConversationResponse(params.id, signal)) {
          if (signal.aborted) break;
          if (event.event === 'keepalive') {
            controller.enqueue(encoder.encode(': keepalive\n\n'));
          } else {
            controller.enqueue(
              encoder.encode(`event: ${event.event}\ndata: ${event.data}\n\n`)
            );
          }
        }
      } catch (error) {
        console.error('[stream] SSE stream aborted for conversation %s:', params.id, error instanceof Error ? error.message : String(error));
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ message: 'Stream error' })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      // stream cancelled by client
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
