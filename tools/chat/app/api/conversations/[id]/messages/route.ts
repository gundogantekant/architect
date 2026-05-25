import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb, query } from '@/lib/db';
import { sendUserMessage } from '@/lib/temporal-client';
import { v4 as uuidv4 } from 'uuid';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { content } = await req.json();
  if (!content || typeof content !== 'string') {
    return NextResponse.json({ error: 'content is required' }, { status: 400 });
  }

  if (content.length > 32_000) {
    return NextResponse.json({ error: 'content too long (max 32000 characters)' }, { status: 400 });
  }

  const convCheck = await query(
    `SELECT id FROM conversations WHERE id = $1 AND user_sub = $2`,
    [params.id, user.sub]
  );
  if (convCheck.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const messageId = uuidv4();
  const dbClient = await getDb().connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(
      `INSERT INTO messages (id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)`,
      [messageId, params.id, content]
    );
    await dbClient.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1`,
      [params.id]
    );
    await dbClient.query('COMMIT');
  } catch (dbError) {
    await dbClient.query('ROLLBACK');
    throw dbError;
  } finally {
    dbClient.release();
  }

  try {
    await sendUserMessage(params.id, { messageId, content });
  } catch (error) {
    return NextResponse.json(
      { messageId, warning: 'Temporal offline — message saved but not processed', detail: (error as Error).message },
      { status: 207 }
    );
  }

  return NextResponse.json({ messageId }, { status: 201 });
}
