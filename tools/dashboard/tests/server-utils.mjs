/**
 * Shared server lifecycle utilities for test infrastructure.
 * Used by both global-setup.mjs (cleanup) and fixtures.mjs (lazy startup).
 *
 * Each test worker gets a dedicated PostgreSQL database named
 * architect_test_<port>_<timestamp>. The database is created before the
 * server spawns and dropped (WITH FORCE) after teardown.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
export const SERVER = join(ROOT, 'tools', 'dashboard', 'server.mjs');
export const BASE_PORT = 3800;

// Production DB name we must never touch during tests.
const PRODUCTION_DB = process.env.ARCHITECT_PG_DB ?? 'architect';

function buildAdminConfig() {
  return {
    host: process.env.ARCHITECT_PG_HOST ?? '127.0.0.1',
    port: parseInt(process.env.ARCHITECT_PG_PORT ?? '3778', 10),
    // Connect to postgres maintenance DB to create/drop test databases.
    database: 'postgres',
    user: process.env.ARCHITECT_PG_USER ?? 'architect',
    password: process.env.ARCHITECT_PG_PASSWORD ?? 'architect',
    connectionTimeoutMillis: 5000,
  };
}

function assertNotProduction(dbName) {
  if (dbName === PRODUCTION_DB) {
    throw new Error(
      `Refusing to operate on production database "${PRODUCTION_DB}". ` +
      `Test databases must have names matching architect_test_*.`
    );
  }
}

export async function createTestDb(dbName) {
  assertNotProduction(dbName);
  const client = new pg.Client(buildAdminConfig());
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}

export async function dropTestDb(dbName) {
  assertNotProduction(dbName);
  const client = new pg.Client(buildAdminConfig());
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

export function killAnyOnPort(port) {
  try {
    const out = execFileSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
    for (const line of out.split('\n').slice(1)) {
      const pid = Number(line.trim().split(/\s+/)[1]);
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

export async function waitPortFree(port, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      execFileSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
      killAnyOnPort(port);
    } catch {
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Port ${port} did not clear within ${maxMs}ms`);
}

export async function waitReadyAndVerify(port, expectedPid, attempts = 50, delayMs = 250) {
  const url = `http://127.0.0.1:${port}/api/server/status`;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        if (data.pid !== expectedPid) {
          try { process.kill(data.pid, 'SIGKILL'); } catch {}
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Test server (pid=${expectedPid}) never became ready on port ${port}`);
}

export function killStalePids() {
  try {
    const pidsFile = join(ROOT, 'tmp', 'test-server.pids');
    for (const pid of readFileSync(pidsFile, 'utf8').split(',').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(pidsFile);
  } catch {}

  try {
    const pwDirPattern = join(ROOT, 'tmp', 'pw-s');
    const out = execFileSync('pgrep', ['-f', pwDirPattern], { encoding: 'utf8' }).trim();
    for (const pid of out.split('\n').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

export async function gracefulKill(pid, timeoutMs = 3000) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 100));
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

/**
 * Spawn a test server against an isolated PostgreSQL database.
 *
 * The database is named architect_test_<port>_<timestamp> and must be created
 * by the caller via createTestDb() before spawning. The caller is responsible
 * for dropping the database after teardown via dropTestDb().
 *
 * workDir is still created for any filesystem artifacts (logs, portfolio), but
 * no SQLite file is used.
 */
function seedTestPortfolio(portfolioDir) {
  const orgDir = join(portfolioDir, 'test-org', 'test-proj.dotted');
  mkdirSync(orgDir, { recursive: true });
  writeFileSync(join(portfolioDir, 'test-org', 'organization.json'), JSON.stringify({ name: 'test-org' }));
  writeFileSync(join(orgDir, 'main.json'), JSON.stringify({ org: 'test-org', project: 'test-proj.dotted', component: 'main' }));
  writeFileSync(join(portfolioDir, 'registry.json'), JSON.stringify({ entries: {} }));
}

export function spawnTestServer(port, workDir, dbName, extraEnv = {}) {
  mkdirSync(workDir, { recursive: true });
  seedTestPortfolio(join(workDir, 'portfolio'));

  const env = {
    ...process.env,
    ...extraEnv,
    PORT: String(port),
    WORK_DIR: workDir,
    PORTFOLIO_DIR: join(workDir, 'portfolio'),
    // Isolated prompts dir per worker — starts absent to allow 503 contract testing
    PROMPTS_DIR: join(workDir, 'prompts'),
    // Override the database name — host/port/user/password come from the
    // ambient environment, matching the real PostgreSQL instance.
    ARCHITECT_PG_DB: dbName,
    // Ensure password default is always propagated to the child process even
    // when the ambient env does not have ARCHITECT_PG_PASSWORD set.
    ARCHITECT_PG_PASSWORD: process.env.ARCHITECT_PG_PASSWORD ?? 'architect',
    // Enable test-only endpoints (e.g. simulate-db-save-error).
    NODE_ENV: 'test',
  };

  const proc = spawn(process.execPath, [SERVER], {
    env,
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  return proc;
}

/**
 * Generate a unique test database name for the given port.
 * Format: architect_test_<port>_<epoch_ms>
 */
export function testDbName(port) {
  return `architect_test_${port}_${Date.now()}`;
}
