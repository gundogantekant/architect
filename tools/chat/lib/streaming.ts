import { getConversationState } from './temporal-client';
import { query } from './db';
import type { SessionState } from './types';

const POLL_INTERVAL_MS = 500;
const MAX_POLL_DURATION_MS = 120_000;

export interface StreamEvent {
  event: string;
  data: string;
}

export async function* streamConversationResponse(
  conversationId: string,
  signal?: AbortSignal
): AsyncGenerator<StreamEvent> {
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let lastSeenState: SessionState | null = null;
  let lastSeenMessageId: string | null = null;

  while (Date.now() < deadline) {
    if (signal?.aborted) return;

    let snapshot;
    try {
      snapshot = await getConversationState(conversationId);
    } catch (error) {
      console.error('[streaming] Temporal query failed for conversation %s:', conversationId, error instanceof Error ? error.message : String(error));
      yield { event: 'error', data: JSON.stringify({ message: 'Temporal offline' }) };
      return;
    }

    const { sessionState } = snapshot;

    if (sessionState === 'done') {
      yield { event: 'done', data: JSON.stringify({ conversationId, sessionState }) };
      return;
    }

    if (sessionState === 'awaiting-approval' && lastSeenState !== 'awaiting-approval') {
      yield { event: 'approval-required', data: JSON.stringify({ conversationId }) };
    }

    if (sessionState === 'idle' && lastSeenState === 'processing') {
      const latestAssistantMessage = await fetchLatestAssistantMessage(conversationId, lastSeenMessageId);
      if (latestAssistantMessage) {
        lastSeenMessageId = latestAssistantMessage.id;
        yield { event: 'message', data: JSON.stringify(latestAssistantMessage) };
      }
      yield { event: 'idle', data: JSON.stringify({ conversationId, sessionState }) };
      return;
    }

    if (sessionState === 'processing') {
      yield { event: 'status', data: JSON.stringify({ sessionState }) };
    }

    lastSeenState = sessionState;
    await sleep(POLL_INTERVAL_MS);
    yield { event: 'keepalive', data: '' };
  }

  yield { event: 'timeout', data: JSON.stringify({ conversationId }) };
}

async function fetchLatestAssistantMessage(conversationId: string, lastSeenId: string | null) {
  const result = await query(
    `SELECT id, content, created_at as "createdAt"
     FROM messages
     WHERE conversation_id = $1 AND role = 'assistant'
       AND ($2::uuid IS NULL OR id != $2)
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [conversationId, lastSeenId]
  );
  return result.rows[0] ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
