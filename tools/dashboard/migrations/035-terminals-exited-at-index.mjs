export const version = 35;
export const name = '035-terminals-exited-at-index';

export async function up(pool) {
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_terminals_exited_at
     ON terminals(exited_at DESC NULLS LAST)
     WHERE deleted_at IS NULL AND status NOT IN ('running', 'suspended')`
  );
}

export async function down(pool) {
  await pool.query(`DROP INDEX IF EXISTS idx_terminals_exited_at`);
}
