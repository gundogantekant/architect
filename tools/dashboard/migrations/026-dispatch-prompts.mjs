// Next available after 025-session-resurrection.mjs (025 taken by W-1139)
// Rollback: DROP TABLE dispatch_prompts;
//   DELETE FROM schema_migrations WHERE version = 26;
//   Remove dispatch_prompts from assertSchema in db.mjs.

export const version = 26;

export async function up(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS dispatch_prompts (
    id SERIAL PRIMARY KEY,
    dispatch_id TEXT REFERENCES dispatches(id) ON DELETE SET NULL,
    work_item_id TEXT,
    project_key TEXT,
    prompt_text TEXT NOT NULL,
    char_count INT,
    truncated BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
}

export async function down(pool) {
  await pool.query('DROP TABLE IF EXISTS dispatch_prompts');
}
