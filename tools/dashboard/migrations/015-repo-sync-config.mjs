export const version = 15;
export const name = '015-repo-sync-config';
export const noTransaction = false;

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS repo_sync_config (
      github_repo_name       TEXT PRIMARY KEY,
      github_org             TEXT NOT NULL DEFAULT 'NeuronicPBM',
      default_branch         TEXT NOT NULL DEFAULT 'main',
      local_path             TEXT,
      portfolio_key          TEXT,
      sync_enabled           BOOLEAN NOT NULL DEFAULT FALSE,
      last_github_updated_at TIMESTAMPTZ,
      created_at             TIMESTAMPTZ NOT NULL,
      updated_at             TIMESTAMPTZ NOT NULL
    )
  `);

  // Composite partial index: fast getEnabledRepos() query
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_repo_sync_config_enabled_path
      ON repo_sync_config(sync_enabled, local_path)
      WHERE sync_enabled = TRUE
  `);
}
