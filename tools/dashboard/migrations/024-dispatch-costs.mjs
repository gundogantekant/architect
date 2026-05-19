// Rollback: DROP TABLE dispatch_costs; DROP TABLE model_pricing;
//   DELETE FROM schema_migrations WHERE version = 24;
//   Remove dispatch_costs and model_pricing from assertSchema in db.mjs.

export const version = 24;

export async function up(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS dispatch_costs (
    id TEXT NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
    model TEXT,
    agent_role TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_tokens INTEGER,
    cost_usd_breakdown NUMERIC(12,8),
    recorded_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS model_pricing (
    model_id TEXT PRIMARY KEY,
    input_cost_per_mtok NUMERIC(10,6) NOT NULL,
    output_cost_per_mtok NUMERIC(10,6) NOT NULL,
    cache_read_cost_per_mtok NUMERIC(10,6) NOT NULL,
    cache_write_cost_per_mtok NUMERIC(10,6) NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Seed current Claude model prices (USD per million tokens)
  await pool.query(`INSERT INTO model_pricing VALUES
    ('claude-opus-4-7',          15.0, 75.0,  1.5,   3.75, NOW()),
    ('claude-sonnet-4-6',         3.0, 15.0,  0.3,   3.75, NOW()),
    ('claude-haiku-4-5-20251001', 0.8,  4.0,  0.08,  1.0,  NOW())
    ON CONFLICT (model_id) DO NOTHING`);
}

export async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS dispatch_costs');
  await pool.query('DROP TABLE IF EXISTS model_pricing');
}
