import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, existsSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile, spawnSync } from 'node:child_process';
import pg from 'pg';
import { backupDatabase, initDatabaseAsync, closeDatabase } from '../db.mjs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// ── Admin client helpers ──────────────────────────────────────────────────────

function buildAdminConfig() {
  return {
    host: process.env.ARCHITECT_PG_HOST ?? '127.0.0.1',
    port: parseInt(process.env.ARCHITECT_PG_PORT ?? '3778', 10),
    database: 'postgres',
    user: process.env.ARCHITECT_PG_USER ?? 'architect',
    password: process.env.ARCHITECT_PG_PASSWORD ?? 'architect',
    connectionTimeoutMillis: 5000,
  };
}

async function createDb(name) {
  const client = new pg.Client(buildAdminConfig());
  await client.connect();
  try { await client.query(`CREATE DATABASE "${name}"`); }
  finally { await client.end(); }
}

async function dropDb(name) {
  const client = new pg.Client(buildAdminConfig());
  await client.connect();
  try { await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); }
  finally { await client.end(); }
}

function dockerContainerRunning(container) {
  try {
    const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', container], { encoding: 'utf8' });
    return result.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

// ── Backup test suite ─────────────────────────────────────────────────────────

describe('backupDatabase', () => {
  let tmpDir;
  let testDbName;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'backup-test-'));
    testDbName = `backup_test_${Date.now()}`;
    await createDb(testDbName);

    process.env.ARCHITECT_PG_DB = testDbName;
    await initDatabaseAsync(tmpDir, MIGRATIONS_DIR);
  });

  after(async () => {
    await closeDatabase();
    delete process.env.ARCHITECT_PG_DB;
    await dropDb(testDbName).catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a timestamped backup file', async () => {
    const backupDir = join(tmpDir, 'backups');

    const dest = await backupDatabase(tmpDir, backupDir);

    assert.ok(dest, 'should return the backup path');
    assert.match(dest, /architect-[\dT\-Z]+\.dump$/);
    assert.ok(existsSync(dest), 'backup file should exist on disk');

    const files = readdirSync(backupDir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^architect-.*\.dump$/);
  });

  it('creates a non-empty backup file with pg_dump magic bytes', async () => {
    const backupDir = join(tmpDir, 'backups2');
    const dest = await backupDatabase(tmpDir, backupDir);
    assert.ok(dest);

    const { statSync } = await import('node:fs');
    const stat = statSync(dest);
    assert.ok(stat.size > 0, 'backup file should be non-empty');

    // Custom format dumps start with "PGDMP" magic bytes
    const fd = openSync(dest, 'r');
    const buf = Buffer.alloc(5);
    readSync(fd, buf, 0, 5, 0);
    closeSync(fd);
    assert.equal(buf.toString('ascii'), 'PGDMP', 'dump file should start with pg_dump custom-format magic bytes');
  });

  it('creates the backup directory if it does not exist', async () => {
    const backupDir = join(tmpDir, 'nested', 'deep', 'backups');
    const dest = await backupDatabase(tmpDir, backupDir);
    assert.ok(dest);
    assert.ok(existsSync(backupDir), 'backup dir should have been created');
    assert.equal(readdirSync(backupDir).length, 1);
  });

  it('can restore the backup to a fresh database via docker exec', async () => {
    const container = process.env.ARCHITECT_PG_CONTAINER ?? 'architect-postgres';
    if (!dockerContainerRunning(container)) {
      console.log(`  skip: container '${container}' not running`);
      return;
    }

    const backupDir = join(tmpDir, 'backups-restore');
    const dest = await backupDatabase(tmpDir, backupDir);
    assert.ok(dest);

    const restoreDb = `backup_restore_test_${Date.now()}`;
    await createDb(restoreDb);

    try {
      const adminCfg = buildAdminConfig();

      // Copy the dump file into the container, then pg_restore inside it.
      // docker cp writes to the container filesystem; pg_restore reads from there.
      const containerDumpPath = `/tmp/restore-test-${Date.now()}.dump`;
      const cpResult = spawnSync('docker', ['cp', dest, `${container}:${containerDumpPath}`], { encoding: 'utf8' });
      if (cpResult.status !== 0) {
        throw new Error(`docker cp failed: ${cpResult.stderr}`);
      }

      await new Promise((resolve, reject) => {
        const child = execFile(
          'docker',
          [
            'exec', container,
            'pg_restore',
            '-h', '127.0.0.1', '-p', '5432',
            '-U', adminCfg.user,
            '-d', restoreDb,
            containerDumpPath,
          ],
          (err) => (err ? reject(new Error(`pg_restore failed: ${err.message}`)) : resolve())
        );
      });

      // Cleanup dump file inside container
      spawnSync('docker', ['exec', container, 'rm', '-f', containerDumpPath]);

      // Verify schema_migrations exists in the restored DB.
      const verifyClient = new pg.Client({ ...adminCfg, database: restoreDb });
      await verifyClient.connect();
      try {
        const result = await verifyClient.query(
          `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_name = 'schema_migrations'`
        );
        assert.ok(parseInt(result.rows[0].c, 10) > 0, 'schema_migrations table should exist after restore');
      } finally {
        await verifyClient.end();
      }
    } finally {
      await dropDb(restoreDb).catch(() => {});
    }
  });
});
