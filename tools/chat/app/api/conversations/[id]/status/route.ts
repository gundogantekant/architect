import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { getConversationState } from '@/lib/temporal-client';
import type { SessionStatusResponse } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const convCheck = await query(
    `SELECT id FROM conversations WHERE id = $1 AND user_sub = $2`,
    [params.id, user.sub]
  );
  if (convCheck.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    const snapshot = await getConversationState(params.id);
    const response: SessionStatusResponse = {
      sessionId: snapshot.sessionId,
      sessionState: snapshot.sessionState,
      messageCount: snapshot.messageCount,
    };
    return NextResponse.json(response);
  } catch {
    return NextResponse.json(
      { sessionId: params.id, sessionState: 'idle', messageCount: 0, offline: true },
      { status: 200 }
    );
  }
}
