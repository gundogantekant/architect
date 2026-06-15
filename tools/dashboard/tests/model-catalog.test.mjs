// Model catalog tests — validateModel resolution, UI↔backend parity, and the
// catalog→pricing→cost path through migration 046.
//
// DB-touching tests follow the migrations.test.mjs harness: each suite creates an
// isolated throwaway PostgreSQL database on the architect PG server (port 3778 by
// default), runs migrations against it, then DROPs it in teardown. They NEVER touch
// the real `architect` database (historical data-loss incident — see MEMORY).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { MODEL_CATALOG, MODEL_ALIASES } from '../model-catalog.mjs';
import { validateModel } from '../utils.mjs';
import { initDatabaseAsync, closeDatabase, insertDispatchCost, getPool } from '../db.mjs';
import { up as migration046Up } from '../migrations/046-model-pricing-refresh.mjs';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const FLOAT_TOL = 1e-9;

// ── PG admin helpers (mirrors migrations.test.mjs) ───────────────────────────

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

function buildDbConfig(dbName) {
  return { ...buildAdminConfig(), database: dbName };
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

// Seed a minimal dispatches row so insertDispatchCost's FK (id → dispatches.id) is
// satisfied. Required NOT NULL columns: project_key, status, started_at.
async function seedDispatchRow(client, id) {
  await client.query(
    `INSERT INTO dispatches (id, project_key, status, started_at)
     VALUES ($1, 'ticari/architect/main', 'completed', NOW())
     ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 1 + 2: validateModel unit + UI↔backend parity  (NO DB)
// ═════════════════════════════════════════════════════════════════════════════

describe('validateModel (no DB)', () => {
  test('MC-1: resolves catalog ids, aliases, suffix preservation, and unknown fallback', () => {
    // Catalog id passes through unchanged (no silent downgrade).
    assert.equal(validateModel('claude-fable-5'), 'claude-fable-5');
    assert.equal(validateModel('claude-opus-4-6'), 'claude-opus-4-6');

    // [1m] suffix preserved on a resolved id.
    assert.equal(validateModel('claude-opus-4-7[1m]'), 'claude-opus-4-7[1m]');

    // Aliases resolve to their pinned latest id.
    assert.equal(validateModel('opus'), 'claude-opus-4-8');
    assert.equal(validateModel('sonnet'), 'claude-sonnet-4-6');
    assert.equal(validateModel('haiku'), 'claude-haiku-4-5-20251001');

    // Alias + suffix resolves and re-appends [1m].
    assert.equal(validateModel('sonnet[1m]'), 'claude-sonnet-4-6[1m]');

    // Unknown / empty fall back to sonnet.
    assert.equal(validateModel('bogus'), 'claude-sonnet-4-6');
    assert.equal(validateModel(''), 'claude-sonnet-4-6');
  });

  test('MC-2: every catalog id the UI can render is accepted by the backend (no downgrade)', () => {
    for (const m of MODEL_CATALOG) {
      // Bare id round-trips unchanged.
      assert.equal(validateModel(m.id), m.id, `bare id downgraded: ${m.id}`);

      if (m.supports1m) {
        // 1M-capable ids round-trip with the [1m] suffix intact.
        assert.equal(
          validateModel(m.id + '[1m]'),
          m.id + '[1m]',
          `[1m] suffix lost for ${m.id}`,
        );
      }
    }
  });

  test('MC-2b: haiku does not advertise 1M (UI must never emit a haiku [1m])', () => {
    const haiku = MODEL_CATALOG.find(m => m.id === MODEL_ALIASES.haiku);
    assert.ok(haiku, 'haiku alias target must exist in catalog');
    assert.equal(haiku.supports1m, false, 'haiku must have supports1m === false');
  });

  test('MC-2c: every alias target is itself a catalog id', () => {
    const ids = new Set(MODEL_CATALOG.map(m => m.id));
    for (const [alias, target] of Object.entries(MODEL_ALIASES)) {
      assert.ok(ids.has(target), `alias '${alias}' → '${target}' is not in MODEL_CATALOG`);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3–6: DB-backed (isolated throwaway database per suite)
// ═════════════════════════════════════════════════════════════════════════════

describe('catalog → pricing → cost (isolated tmp PG)', () => {
  let testDbName;
  let tmpDir;

  before(async () => {
    testDbName = `mc_test_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await createDb(testDbName);
    process.env.ARCHITECT_PG_DB = testDbName;
    tmpDir = mkdtempSync(join(tmpdir(), 'mc-test-'));
    // Runs every migration (incl. 046) against the isolated DB and wires the
    // module-level pool used by insertDispatchCost.
    await initDatabaseAsync(tmpDir, MIGRATIONS_DIR);
  });

  after(async () => {
    await closeDatabase();
    delete process.env.ARCHITECT_PG_DB;
    await dropDb(testDbName).catch(() => {});
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
    testDbName = null;
  });

  // ── 3: catalog ↔ pricing parity ──────────────────────────────────────────
  test('MC-3: model_pricing has a row for every catalog id with derived cache rates', async () => {
    const pool = getPool();
    const { rows } = await pool.query('SELECT * FROM model_pricing');
    const byId = new Map(rows.map(r => [r.model_id, r]));

    for (const m of MODEL_CATALOG) {
      const row = byId.get(m.id);
      assert.ok(row, `model_pricing missing row for catalog id ${m.id}`);

      assert.equal(Number(row.input_cost_per_mtok), m.input, `input mismatch for ${m.id}`);
      assert.equal(Number(row.output_cost_per_mtok), m.output, `output mismatch for ${m.id}`);

      assert.ok(
        Math.abs(Number(row.cache_read_cost_per_mtok) - m.input * 0.1) < FLOAT_TOL,
        `cache_read mismatch for ${m.id}: got ${row.cache_read_cost_per_mtok}, want ${m.input * 0.1}`,
      );
      assert.ok(
        Math.abs(Number(row.cache_write_cost_per_mtok) - m.input * 1.25) < FLOAT_TOL,
        `cache_write mismatch for ${m.id}: got ${row.cache_write_cost_per_mtok}, want ${m.input * 1.25}`,
      );
    }
  });

  // ── 4: cost computation + [1m] suffix-strip guard ────────────────────────
  test('MC-4: insertDispatchCost bills 5.0 for 1M Opus-4.8 input tokens, with and without [1m]', async () => {
    const pool = getPool();

    const idA = `D-${randomUUID().slice(0, 8)}`;
    await seedDispatchRow(pool, idA);
    const costPin = await insertDispatchCost({
      id: idA,
      model: 'claude-opus-4-8',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // 1_000_000 * 5 / 1_000_000 = 5.0
    assert.ok(Math.abs(Number(costPin) - 5.0) < 1e-6, `expected 5.0, got ${costPin}`);

    const idB = `D-${randomUUID().slice(0, 8)}`;
    await seedDispatchRow(pool, idB);
    const costSuffix = await insertDispatchCost({
      id: idB,
      model: 'claude-opus-4-8[1m]',
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // Suffix is stripped before pricing lookup → identical 5.0 bill.
    assert.ok(Math.abs(Number(costSuffix) - 5.0) < 1e-6, `expected 5.0 for [1m], got ${costSuffix}`);
    assert.equal(Number(costPin), Number(costSuffix));
  });

  // ── 5: alias ↔ pin convergence ───────────────────────────────────────────
  test('MC-5: alias-reported model id bills the same non-zero cost as an explicit pin', async () => {
    const pool = getPool();

    // The CLI reports the resolved id (what `opus` resolves to) on the cost path.
    const aliasResolvedId = MODEL_ALIASES.opus; // 'claude-opus-4-8'
    assert.equal(validateModel('opus'), aliasResolvedId);

    const idAlias = `D-${randomUUID().slice(0, 8)}`;
    await seedDispatchRow(pool, idAlias);
    const aliasCost = await insertDispatchCost({
      id: idAlias,
      model: aliasResolvedId,
      inputTokens: 250_000,
      outputTokens: 40_000,
    });

    const idPin = `D-${randomUUID().slice(0, 8)}`;
    await seedDispatchRow(pool, idPin);
    const pinCost = await insertDispatchCost({
      id: idPin,
      model: 'claude-opus-4-8',
      inputTokens: 250_000,
      outputTokens: 40_000,
    });

    assert.ok(Number(aliasCost) > 0, 'alias cost must be non-zero');
    assert.equal(Number(aliasCost), Number(pinCost));
  });

  // ── 6: migration 046 idempotency ─────────────────────────────────────────
  test('MC-6: running migration 046 up() twice leaves prices converged and unchanged', async () => {
    const client = new pg.Client(buildDbConfig(testDbName));
    await client.connect();
    try {
      // model_pricing already populated by initDatabaseAsync's migration run.
      await migration046Up(client);
      const first = await client.query(
        'SELECT model_id, input_cost_per_mtok, output_cost_per_mtok, cache_read_cost_per_mtok, cache_write_cost_per_mtok FROM model_pricing ORDER BY model_id',
      );

      // Second run must not error and must not change the priced values.
      await migration046Up(client);
      const second = await client.query(
        'SELECT model_id, input_cost_per_mtok, output_cost_per_mtok, cache_read_cost_per_mtok, cache_write_cost_per_mtok FROM model_pricing ORDER BY model_id',
      );

      assert.equal(first.rows.length, second.rows.length);
      for (let i = 0; i < first.rows.length; i++) {
        const a = first.rows[i];
        const b = second.rows[i];
        assert.equal(a.model_id, b.model_id);
        assert.equal(Number(a.input_cost_per_mtok), Number(b.input_cost_per_mtok), `input drift for ${a.model_id}`);
        assert.equal(Number(a.output_cost_per_mtok), Number(b.output_cost_per_mtok), `output drift for ${a.model_id}`);
        assert.equal(Number(a.cache_read_cost_per_mtok), Number(b.cache_read_cost_per_mtok), `cache_read drift for ${a.model_id}`);
        assert.equal(Number(a.cache_write_cost_per_mtok), Number(b.cache_write_cost_per_mtok), `cache_write drift for ${a.model_id}`);
      }

      // And every catalog id is present after the double run.
      const ids = new Set(second.rows.map(r => r.model_id));
      for (const m of MODEL_CATALOG) {
        assert.ok(ids.has(m.id), `catalog id ${m.id} missing after idempotent re-run`);
      }
    } finally {
      await client.end();
    }
  });
});
