// claude_session_id on terminals: Claude-assigned UUID for this session (injected at
// spawn or inherited on resume). On cli_sessions: UUID reported by external CLI at
// registration time — externally sourced, not dashboard-controlled.

export const id = '047-session-resume-fields';
export const description = 'Add model to terminals and claude_session_id + model to cli_sessions';

export async function up(pool) {
  await pool.query(`ALTER TABLE terminals ADD COLUMN IF NOT EXISTS model TEXT`);
  await pool.query(`ALTER TABLE cli_sessions ADD COLUMN IF NOT EXISTS claude_session_id TEXT`);
  await pool.query(`ALTER TABLE cli_sessions ADD COLUMN IF NOT EXISTS model TEXT`);
}

export async function down(pool) {
  await pool.query(`ALTER TABLE terminals DROP COLUMN IF EXISTS model`);
  await pool.query(`ALTER TABLE cli_sessions DROP COLUMN IF EXISTS claude_session_id`);
  await pool.query(`ALTER TABLE cli_sessions DROP COLUMN IF EXISTS model`);
}
