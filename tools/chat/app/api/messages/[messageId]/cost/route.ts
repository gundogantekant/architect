import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth';
import { query } from '@/lib/db';
import type { TokenCost } from '@/lib/types';

export const runtime = 'nodejs';

export async function GET(req: NextRequest, { params }: { params: { messageId: string } }) {
  const user = await getAuthenticatedUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const result = await query<TokenCost>(
    `SELECT tu.id, tu.message_id AS "messageId", tu.input_tokens AS "inputTokens",
            tu.output_tokens AS "outputTokens", tu.model, tu.cost_usd::text AS "costUsd"
     FROM token_usage tu
     JOIN messages m ON m.id = tu.message_id
     JOIN conversations c ON c.id = m.conversation_id
     WHERE tu.message_id = $1 AND c.user_sub = $2`,
    [params.messageId, user.sub]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(result.rows[0]);
}
