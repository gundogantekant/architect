export const version = 2;
export const name = '002-pipeline-stage';
export const noTransaction = false;

export async function up(client) {
  await client.query(`
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS pipeline_stage TEXT
  `);
}
