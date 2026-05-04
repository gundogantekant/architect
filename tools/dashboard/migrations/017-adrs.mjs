export const version = 17;
export const name = '017-adrs';
export const noTransaction = false;

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS adrs (
      id          TEXT PRIMARY KEY,
      org_key     TEXT NOT NULL,
      title       TEXT NOT NULL,
      type        TEXT NOT NULL
        CONSTRAINT chk_adrs_type
          CHECK (type IN ('architectural', 'dependency', 'feature', 'api-contract')),
      repos       JSONB NOT NULL DEFAULT '[]'::jsonb,
      sync_run_id TEXT,
      detail_path TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_adrs_org_key ON adrs(org_key)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_adrs_created_at ON adrs(created_at DESC)`);
}
