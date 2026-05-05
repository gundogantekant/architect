export const version = 19;
export const name = '019-agent-phase-column';
export const noTransaction = false;

export async function up(client) {
  await client.query(`
    ALTER TABLE dispatches
      ADD COLUMN IF NOT EXISTS agent_phase TEXT DEFAULT NULL,
      ADD COLUMN IF NOT EXISTS agent_phase_history JSONB DEFAULT '[]'::jsonb
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE dispatches
      DROP COLUMN IF EXISTS agent_phase,
      DROP COLUMN IF EXISTS agent_phase_history
  `);
}
