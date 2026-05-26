import { Pool, QueryResult, QueryResultRow } from 'pg';

let pool: Pool | null = null;

export function getDb(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      options: '-c search_path=ai_chat',
    });
    pool.on('error', (err) => console.error('[db] Idle client error:', err));
  }
  return pool;
}

if (typeof process !== 'undefined') {
  process.on('SIGTERM', () => { pool?.end().catch(() => {}); });
  process.on('SIGINT', () => { pool?.end().catch(() => {}); });
}

export function closeDb(): Promise<void> {
  return pool?.end() ?? Promise.resolve();
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  return getDb().query<T>(text, params);
}
