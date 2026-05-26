import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { query } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const convResult = await query(
    `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt"
     FROM conversations WHERE id = $1 AND user_sub = $2`,
    [params.id, user.sub]
  );
  if (convResult.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const msgResult = await query(
    `SELECT id, role, content, created_at AS "createdAt"
     FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
    [params.id]
  );

  return NextResponse.json({ ...convResult.rows[0], messages: msgResult.rows });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await query(
    `DELETE FROM conversations WHERE id = $1 AND user_sub = $2`,
    [params.id, user.sub]
  );
  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return new NextResponse(null, { status: 204 });
}
