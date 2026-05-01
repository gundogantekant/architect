export const version = 16;
export const name = '016-sync-source-column';
export const noTransaction = false;

export async function up(client) {
  await client.query(`
    ALTER TABLE knowledge_syncs
      ADD COLUMN IF NOT EXISTS sync_source TEXT NOT NULL DEFAULT 'local'
        CONSTRAINT chk_knowledge_syncs_sync_source
          CHECK (sync_source IN ('local', 'remote'))
  `);
}
