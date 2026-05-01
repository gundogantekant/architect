import pg from 'pg';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

// Return TIMESTAMPTZ values as ISO strings instead of Date objects.
// OID 1114 = TIMESTAMP WITHOUT TIME ZONE, OID 1184 = TIMESTAMP WITH TIME ZONE.
pg.types.setTypeParser(1114, (val) => val);
pg.types.setTypeParser(1184, (val) => val);

let pool = null;

function buildPoolConfig() {
  return {
    host: process.env.ARCHITECT_PG_HOST ?? '127.0.0.1',
    port: parseInt(process.env.ARCHITECT_PG_PORT ?? '5432', 10),
    database: process.env.ARCHITECT_PG_DB ?? 'architect',
    user: process.env.ARCHITECT_PG_USER ?? 'architect',
    password: process.env.ARCHITECT_PG_PASSWORD,
    max: parseInt(process.env.PG_POOL_MAX ?? '10', 10),
    idleTimeoutMillis: parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS ?? '30000', 10),
    connectionTimeoutMillis: parseInt(process.env.PG_CONNECTION_TIMEOUT_MS ?? '5000', 10),
    statementTimeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS ?? '30000', 10),
  };
}

export async function waitForPostgres(config, { maxAttempts = 10, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const probe = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
    });
    try {
      await probe.connect();
      await probe.query('SELECT 1');
      await probe.end();
      return;
    } catch (err) {
      lastError = err;
      await probe.end().catch(() => {});

      // Non-retryable: wrong credentials or DB doesn't exist yet via pg_hba.
      // ECONNREFUSED means postgres isn't up yet — keep retrying.
      if (err.code === '28P01') throw new Error(`PostgreSQL auth failed (28P01): check ARCHITECT_PG_USER/PASSWORD`);
      if (err.code === '3D000') throw new Error(`PostgreSQL database not found (3D000): check ARCHITECT_PG_DB="${config.database}"`);

      if (attempt < maxAttempts) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 10000);
        console.log(JSON.stringify({ type: 'pg_wait', attempt, maxAttempts, delayMs: delay, code: err.code, timestamp: new Date().toISOString() }));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`PostgreSQL not reachable after ${maxAttempts} attempts: ${lastError?.message}`);
}

async function applyStatementTimeout(client, timeoutMs) {
  await client.query(`SET statement_timeout = '${timeoutMs}ms'`);
  await client.query(`SET idle_in_transaction_session_timeout = '${timeoutMs}ms'`);
}

export async function initDatabaseAsync(workDir, migrationsDir) {
  const config = buildPoolConfig();
  await waitForPostgres(config);

  pool = new pg.Pool(config);

  pool.on('error', (err) => {
    console.error(JSON.stringify({ type: 'pg_pool_error', message: err.message, code: err.code, timestamp: new Date().toISOString() }));
  });

  pool.on('connect', async (client) => {
    await applyStatementTimeout(client, config.statementTimeout);
  });

  await runMigrations(migrationsDir);
}

export async function runMigrations(migrationsDir) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL,
        notes TEXT
      )
    `);

    const { rows: appliedRows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.version));

    const allFiles = await readdir(migrationsDir);
    const migrationFiles = allFiles
      .filter((f) => /^\d{3}-.+\.mjs$/.test(f))
      .sort();

    assertNoDuplicateVersions(migrationFiles);

    for (const file of migrationFiles) {
      const version = parseInt(file.slice(0, 3), 10);
      if (applied.has(version)) {
        console.log(`Skipping migration ${file} (version ${version} already applied).`);
        continue;
      }

      console.log(`Applying migration ${file}...`);
      const migration = await import(join(migrationsDir, file));

      if (migration.noTransaction) {
        await migration.up(client);
        await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())', [version]);
      } else {
        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query('INSERT INTO schema_migrations (version, applied_at) VALUES ($1, NOW())', [version]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }
      console.log(`Migration ${file} applied.`);
    }
  } finally {
    client.release();
  }
}

function assertNoDuplicateVersions(files) {
  const seen = new Map();
  for (const file of files) {
    const v = parseInt(file.slice(0, 3), 10);
    if (seen.has(v)) {
      const nextFree = Math.max(...seen.keys()) + 1;
      throw new Error(
        `Duplicate migration version ${v}: "${seen.get(v)}" and "${file}". ` +
        `Rename one to ${String(nextFree).padStart(3, '0')}-<name>.mjs.`
      );
    }
    seen.set(v, file);
  }
}

export function closeDatabase() {
  return pool?.end();
}

export function getDb() {
  return pool;
}
