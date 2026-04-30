import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initDatabaseAsync, closeDatabase } from '../db.mjs';

/**
 * MG-1: migration files have unique version numbers.
 *
 * The W-951 incident was caused by two files sharing version 008
 * (008-org-key-column.mjs and 008-work-item-state-machine.mjs). The
 * alphabetically-first applied and recorded v8; the second was silently
 * skipped for three weeks. This test catches that class at PR time.
 */
test('MG-1: migration files have unique version numbers', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
  const files = readdirSync(dir).filter(f => /^\d{3}-.+\.mjs$/.test(f));
  const seen = new Map();
  for (const f of files) {
    const v = parseInt(f.slice(0, 3), 10);
    assert.ok(!seen.has(v), `Duplicate version ${v}: ${seen.get(v)} and ${f}`);
    seen.set(v, f);
  }
});

// ── MG-2 / MG-3 / MG-4: migration runner runtime guardrails ──────────────────
// These tests exercise initDatabaseAsync directly using isolated tmp databases
// and migration directories. Each test uses a fresh tmp dir via beforeEach and
// calls closeDatabase() in afterEach to reset the module-level singleton.

let tmpDir;
let emptyMigsDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mg-test-'));
  emptyMigsDir = mkdtempSync(join(tmpdir(), 'mg-migs-'));
});

afterEach(() => {
  closeDatabase();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  if (emptyMigsDir) rmSync(emptyMigsDir, { recursive: true, force: true });
  tmpDir = null;
  emptyMigsDir = null;
});

function seedDriftDb(dir) {
  const db = new Database(join(dir, 'architect.db'));
  db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  // Mark a fake high version applied so the runner skips all real migrations.
  db.exec(`INSERT INTO schema_migrations VALUES (999, datetime('now'))`);
  // work_items intentionally missing input_needed and approval_active columns.
  db.exec(`CREATE TABLE work_items (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft')`);
  // Minimal stubs for other tables in the assertion manifest.
  db.exec(`CREATE TABLE work_item_approvals (work_item_id TEXT, identity TEXT, status TEXT, sort_order INTEGER, decided_at TEXT, reason TEXT)`);
  db.exec(`CREATE TABLE terminals (org_key TEXT)`);
  db.exec(`CREATE TABLE dispatches (org_key TEXT, dispatch_mode TEXT, worktree_path TEXT)`);
  db.exec(`CREATE TABLE epics (id TEXT PRIMARY KEY)`);
  db.close();
}

test('MG-2: schema assertion throws when expected columns are missing', async () => {
  seedDriftDb(tmpDir);
  await assert.rejects(
    () => initDatabaseAsync(tmpDir, emptyMigsDir),
    /Schema drift detected/,
  );
});

test('MG-3: ARCHITECT_SKIP_SCHEMA_ASSERT=1 bypasses schema drift', async () => {
  seedDriftDb(tmpDir);
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
    writeFileSync(join(dupMigsDir, '001-alpha.mjs'), 'export function up(db) {}');
    writeFileSync(join(dupMigsDir, '001-beta.mjs'), 'export function up(db) {}');
    await assert.rejects(
      () => initDatabaseAsync(tmpDir, dupMigsDir),
      /Duplicate migration version 1/,
    );
  } finally {
    rmSync(dupMigsDir, { recursive: true, force: true });
  }
});
