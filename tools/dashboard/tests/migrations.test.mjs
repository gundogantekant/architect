import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import pg from 'pg';
import { initDatabaseAsync, closeDatabase } from '../db.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// ── Admin client helpers ──────────────────────────────────────────────────────

function buildAdminConfig() {
  return {
    host: process.env.ARCHITECT_PG_HOST ?? '127.0.0.1',
    port: parseInt(process.env.ARCHITECT_PG_PORT ?? '3778', 10),
    database: 'postgres',
    user: process.env.ARCHITECT_PG_USER ?? 'architect',
    password: process.env.ARCHITECT_PG_PASSWORD,
    connectionTimeoutMillis: 5000,
  };
}

async function createDb(name) {
  const client = new pg.Client(buildAdminConfig());
  await client.connect();
  try {
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
}

async function dropDb(name) {
  const client = new pg.Client(buildAdminConfig());
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

// Seed a PG database with a pre-applied fake high version and tables that are
// missing columns, simulating schema drift.
async function seedDriftDb(dbName) {
  const client = new pg.Client({
    ...buildAdminConfig(),
    database: dbName,
  });
  await client.connect();
  try {
    // Mark fake high version so the runner skips all real migrations.
    await client.query(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL,
        notes TEXT
      )
    `);
    await client.query(`INSERT INTO schema_migrations (version, applied_at) VALUES (999, NOW())`);

    // work_items intentionally missing input_needed and approval_active columns.
    await client.query(`
      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'draft'
      )
    `);

    // Minimal stubs required to satisfy FK paths.
    await client.query(`CREATE TABLE work_item_approvals (work_item_id TEXT, identity TEXT, status TEXT, sort_order INTEGER, decided_at TIMESTAMPTZ, reason TEXT)`);
    await client.query(`CREATE TABLE terminals (org_key TEXT)`);
    await client.query(`CREATE TABLE dispatches (org_key TEXT, dispatch_mode TEXT, worktree_path TEXT)`);
    await client.query(`CREATE TABLE epics (id TEXT PRIMARY KEY)`);
  } finally {
    await client.end();
  }
}

// ── MG-1: file-level uniqueness (no PG needed) ───────────────────────────────

/**
 * MG-1: migration files have unique version numbers.
 *
 * The W-951 incident was caused by two files sharing version 008
 * (008-org-key-column.mjs and 008-work-item-state-machine.mjs). The
 * alphabetically-first applied and recorded v8; the second was silently
 * skipped for three weeks. This test catches that class at PR time.
 */
test('MG-1: migration files have unique version numbers', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter(f => /^\d{3}-.+\.mjs$/.test(f));
  const seen = new Map();
  for (const f of files) {
    const v = parseInt(f.slice(0, 3), 10);
    assert.ok(!seen.has(v), `Duplicate version ${v}: ${seen.get(v)} and ${f}`);
    seen.set(v, f);
  }
});

// ── MG-2 / MG-3 / MG-4: migration runner runtime guardrails ──────────────────
// Each test creates its own isolated PostgreSQL database. closeDatabase() is
// called in afterEach to reset the module-level pool singleton.

let testDbName;
let tmpDir;
let emptyMigsDir;

beforeEach(async () => {
  testDbName = `mg_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  await createDb(testDbName);

  // Override PG DB so initDatabaseAsync connects to the test database.
  process.env.ARCHITECT_PG_DB = testDbName;

  tmpDir = mkdtempSync(join(tmpdir(), 'mg-test-'));
  emptyMigsDir = mkdtempSync(join(tmpdir(), 'mg-migs-'));
});

afterEach(async () => {
  await closeDatabase();
  delete process.env.ARCHITECT_PG_DB;

  await dropDb(testDbName).catch(() => {});
  testDbName = null;

  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  if (emptyMigsDir) rmSync(emptyMigsDir, { recursive: true, force: true });
  tmpDir = null;
  emptyMigsDir = null;
});

test('MG-2: schema assertion throws when expected columns are missing', async () => {
  await seedDriftDb(testDbName);
  await assert.rejects(
    () => initDatabaseAsync(tmpDir, emptyMigsDir),
    /Schema drift detected/,
  );
});

test('MG-3: ARCHITECT_SKIP_SCHEMA_ASSERT=1 bypasses schema drift', async () => {
  await seedDriftDb(testDbName);
  process.env.ARCHITECT_SKIP_SCHEMA_ASSERT = '1';
  try {
    await assert.doesNotReject(() => initDatabaseAsync(tmpDir, emptyMigsDir));
  } finally {
    delete process.env.ARCHITECT_SKIP_SCHEMA_ASSERT;
  }
});

test('MG-4: duplicate migration version numbers throw at runtime', async () => {
  const dupMigsDir = mkdtempSync(join(tmpdir(), 'mg4-migs-'));
  try {
    writeFileSync(join(dupMigsDir, '001-alpha.mjs'), 'export async function up(client) {}');
    writeFileSync(join(dupMigsDir, '001-beta.mjs'), 'export async function up(client) {}');
    await assert.rejects(
      () => initDatabaseAsync(tmpDir, dupMigsDir),
      /Duplicate migration version 1/,
    );
  } finally {
    rmSync(dupMigsDir, { recursive: true, force: true });
  }
});
