import { getDb } from './db';

export async function verifyDatabaseSchema(): Promise<void> {
  try {
    const db = getDb();
    const result = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'ai_chat' AND table_name = 'users'
    `);
    if (result.rows.length === 0) {
      throw new Error(
        'Migration 032 not applied: ai_chat.users table missing. ' +
        'Run tools/dashboard to apply migrations, then restart this server.'
      );
    }
    console.log('[startup] DB schema verified — migration 032 present');
  } catch (err) {
    console.error('[startup] FATAL: DB schema check failed:', err instanceof Error ? err.message : String(err));
    throw err;
  }
}
