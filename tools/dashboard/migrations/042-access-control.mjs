export const version = 42;
export const name = '042-access-control';
export const noTransaction = false;

export async function up(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_log (
      ip TEXT NOT NULL,
      path TEXT NOT NULL,
      method TEXT NOT NULL,
      status_code INTEGER,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS access_log_ip_idx ON access_log(ip)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ip_blocklist (
      ip TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function down(pool) {
  await pool.query(`DROP TABLE IF EXISTS access_log`);
  await pool.query(`DROP TABLE IF EXISTS ip_blocklist`);
}
