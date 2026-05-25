import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { startConversationWorkflow } from '@/lib/temporal-client';
import { ensureUser } from '@/lib/user';
import { v4 as uuidv4 } from 'uuid';

export const runtime = 'nodejs';

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await query(
    `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM conversations WHERE user_sub = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [user.sub]
  );
  return NextResponse.json(result.rows);
}

export async function POST(req: NextRequest) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  await ensureUser(user);

  const { title } = await req.json().catch(() => ({}));
  const conversationId = uuidv4();

  await query(
    `INSERT INTO conversations (id, user_sub, title) VALUES ($1, $2, $3)`,
    [conversationId, user.sub, title ?? null]
  );

  try {
    await startConversationWorkflow(conversationId, user.sub);
  } catch (error) {
    return NextResponse.json(
      { error: 'Temporal offline', conversationId, detail: (error as Error).message },
      { status: 503 }
    );
  }

  return NextResponse.json({ id: conversationId, title: title ?? null }, { status: 201 });
}
