import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { query } from '@/lib/db';
import { sendApproval } from '@/lib/temporal-client';
import type { SendSignalRequest } from '@/lib/types';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const convCheck = await query(
    `SELECT id FROM conversations WHERE id = $1 AND user_sub = $2`,
    [params.id, user.sub]
  );
  if (convCheck.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const body: SendSignalRequest = await req.json();

  if (body.signalType === 'approval') {
    try {
      await sendApproval(params.id, {
        approver: user.sub,
        approved: body.payload?.approved ?? true,
        comment: body.payload?.comment,
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json(
        { error: 'Temporal offline', detail: (error instanceof Error ? error.message : String(error)) },
        { status: 503 }
      );
    }
  }

  if (body.signalType === 'extend') {
    try {
      await sendApproval(params.id, {
        approver: user.sub,
        approved: true,
        comment: 'session-extended',
      });
      return NextResponse.json({ ok: true });
    } catch (error) {
      return NextResponse.json(
        { error: 'Temporal offline', detail: (error instanceof Error ? error.message : String(error)) },
        { status: 503 }
      );
    }
  }

  return NextResponse.json({ error: `Unknown signalType: ${body.signalType}` }, { status: 400 });
}
