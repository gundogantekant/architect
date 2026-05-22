/**
 * FK-1 / FK-2: dispatch_prompts FK ordering
 *
 * FK-1: inserting a dispatch_prompts row before the parent dispatches row exists
 *       must fail with PostgreSQL error code 23503 (foreign_key_violation).
 *
 * FK-2: inserting a dispatch_prompts row after the parent dispatches row exists
 *       must succeed and be retrievable.
 *
 * Uses an isolated test database with only the minimal schema required to reproduce
 * the FK constraint — avoids the full migration runner (which has a duplicate-version
 * issue on this branch unrelated to this fix).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

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

function buildClientConfig(dbName) {
  return { ...buildAdminConfig(), database: dbName };
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

let testDbName;
let sharedClient;

before(async () => {
  testDbName = `fk_prompt_test_${Date.now()}`;
  await createDb(testDbName);

  sharedClient = new pg.Client(buildClientConfig(testDbName));
  await sharedClient.connect();

  // Minimal schema: only the two tables involved in the FK constraint.
  await sharedClient.query(`
    CREATE TABLE dispatches (
      id TEXT PRIMARY KEY,
      project_key TEXT,
      title TEXT,
      permission_mode TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await sharedClient.query(`
    CREATE TABLE dispatch_prompts (
      id SERIAL PRIMARY KEY,
      dispatch_id TEXT REFERENCES dispatches(id) ON DELETE SET NULL,
      work_item_id TEXT,
      project_key TEXT,
      prompt_text TEXT NOT NULL,
      char_count INT,
      truncated BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
});

after(async () => {
  await sharedClient.end().catch(() => {});
  await dropDb(testDbName).catch(() => {});
});

test('FK-1: inserting dispatch_prompts before parent dispatches row fails with code 23503', async () => {
  const nonExistentDispatchId = `D-fk1-${Date.now()}`;
  await assert.rejects(
    () => sharedClient.query(
      `INSERT INTO dispatch_prompts (dispatch_id, prompt_text) VALUES ($1, $2)`,
      [nonExistentDispatchId, 'test prompt']
    ),
    (err) => {
      assert.equal(err.code, '23503', `expected FK violation (23503) but got: ${err.code} — ${err.message}`);
      return true;
    }
  );
});

test('FK-2: inserting dispatch_prompts after parent dispatches row succeeds', async () => {
  const dispatchId = `D-fk2-${Date.now()}`;

  await sharedClient.query(
    `INSERT INTO dispatches (id, project_key, title, permission_mode, status, started_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [dispatchId, 'test-project', 'FK test dispatch', 'acceptEdits', 'running']
  );

  await sharedClient.query(
    `INSERT INTO dispatch_prompts (dispatch_id, prompt_text, char_count, truncated)
     VALUES ($1, $2, $3, $4)`,
    [dispatchId, 'test prompt text', 16, false]
  );

  const result = await sharedClient.query(
    `SELECT dispatch_id, prompt_text FROM dispatch_prompts WHERE dispatch_id = $1`,
    [dispatchId]
  );

  assert.equal(result.rows.length, 1, 'exactly one prompt record should exist');
  assert.equal(result.rows[0].dispatch_id, dispatchId);
  assert.equal(result.rows[0].prompt_text, 'test prompt text');
});
