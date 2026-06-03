/**
 * Ticket Prefix Tests (W-1255)
 *
 * Covers configurable ticket prefixes: GEN-NNNNN for custom-prefix projects,
 * W-NNN fallback for unconfigured projects, sequence persistence, duplicate
 * prefix detection in buildPrefixCache, and the /api/sequences/next endpoint.
 *
 * Split into two sections:
 *   1. Unit tests — buildPrefixCache + db module logic (no HTTP server needed)
 *   2. HTTP integration tests — full E2E via a dedicated test server seeded
 *      with portfolio JSON files that carry ticket_prefix / ticket_start fields.
 *
 * Run with:
 *   node --test tools/dashboard/tests/ticket-prefix.spec.mjs
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { buildPrefixCache } from '../portfolio-config.mjs';
import {
  createTestDb,
  dropTestDb,
  spawnTestServer,
  killAnyOnPort,
  waitPortFree,
  waitReadyAndVerify,
  gracefulKill,
  testDbName,
  ROOT,
} from './server-utils.mjs';

// ─── helpers ──────────────────────────────────────────────────────────────────

const TEST_PORT = 3870; // well outside the Playwright band (3800–3884)

async function api(port, path, opts = {}) {
  const url = `http://127.0.0.1:${port}/api/${path}`;
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts,
  });
  const text = await resp.text().catch(() => '');
  const body = text ? JSON.parse(text) : null;
  // Surface non-ok responses without throwing so tests can assert on status codes
  return { status: resp.status, ok: resp.ok, body };
}

/**
 * Seed a portfolio directory with a custom-prefix project entry.
 * portfolioDir is the root of the portfolio (org/project/component structure).
 */
function seedPrefixPortfolio(portfolioDir, entries) {
  // entries: [{ org, project, component, ticket_prefix, ticket_start? }]
  for (const e of entries) {
    const orgDir = join(portfolioDir, e.org);
    const projDir = join(orgDir, e.project);
    mkdirSync(projDir, { recursive: true });
    // organization.json (may already exist — OK to overwrite)
    writeFileSync(join(orgDir, 'organization.json'), JSON.stringify({ name: e.org }));
    const data = { org: e.org, project: e.project, component: e.component };
    if (e.ticket_prefix) data.ticket_prefix = e.ticket_prefix;
    if (e.ticket_start !== undefined) data.ticket_start = e.ticket_start;
    writeFileSync(join(projDir, `${e.component}.json`), JSON.stringify(data));
  }
  // registry.json at root
  writeFileSync(join(portfolioDir, 'registry.json'), JSON.stringify({ entries: {} }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Unit: buildPrefixCache
// ─────────────────────────────────────────────────────────────────────────────

test('TP-U1: buildPrefixCache returns empty map for a valid portfolio with no ticket_prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u1-'));
  try {
    seedPrefixPortfolio(dir, [{ org: 'acme', project: 'app', component: 'main' }]);
    const cache = await buildPrefixCache(dir);
    assert.strictEqual(cache.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-U2: buildPrefixCache includes a valid prefix entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u2-'));
  try {
    seedPrefixPortfolio(dir, [
      { org: 'neuronic', project: 'cortex', component: 'main', ticket_prefix: 'GEN', ticket_start: 10000 },
    ]);
    const cache = await buildPrefixCache(dir);
    assert.strictEqual(cache.size, 1);
    const entry = cache.get('neuronic/cortex/main');
    assert.ok(entry, 'cache should have neuronic/cortex/main');
    assert.strictEqual(entry.prefix, 'GEN');
    assert.strictEqual(entry.ticketStart, 10000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-U3: buildPrefixCache excludes reserved prefix W', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u3-'));
  try {
    seedPrefixPortfolio(dir, [
      { org: 'ticari', project: 'architect', component: 'main', ticket_prefix: 'W' },
    ]);
    const cache = await buildPrefixCache(dir);
    assert.strictEqual(cache.size, 0, 'W is reserved and must be excluded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-U4: buildPrefixCache excludes reserved prefix E', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u4-'));
  try {
    seedPrefixPortfolio(dir, [
      { org: 'ticari', project: 'architect', component: 'main', ticket_prefix: 'E' },
    ]);
    const cache = await buildPrefixCache(dir);
    assert.strictEqual(cache.size, 0, 'E is reserved and must be excluded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-U5: buildPrefixCache excludes both projects when two share the same prefix', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u5-'));
  try {
    seedPrefixPortfolio(dir, [
      { org: 'acme', project: 'alpha', component: 'main', ticket_prefix: 'DUP', ticket_start: 1 },
      { org: 'acme', project: 'beta', component: 'main', ticket_prefix: 'DUP', ticket_start: 1 },
    ]);
    const cache = await buildPrefixCache(dir);
    assert.strictEqual(cache.size, 0, 'both entries sharing DUP prefix must be excluded');
    assert.ok(!cache.has('acme/alpha/main'), 'first claimant must be removed');
    assert.ok(!cache.has('acme/beta/main'), 'second claimant must be excluded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-U6: buildPrefixCache does not throw on ENOENT (missing portfolio dir)', async () => {
  const nonExistent = join(tmpdir(), `tp-u6-${Date.now()}`);
  // Must resolve to an empty map without throwing
  const cache = await buildPrefixCache(nonExistent);
  assert.strictEqual(cache.size, 0);
});

test('TP-U7: buildPrefixCache ignores registry.json at root level', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u7-'));
  try {
    // Write only registry.json — no org dirs
    writeFileSync(join(dir, 'registry.json'), JSON.stringify({ ticket_prefix: 'HACK', entries: {} }));
    const cache = await buildPrefixCache(dir);
    assert.strictEqual(cache.size, 0, 'registry.json must not be treated as a component');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-U8: buildPrefixCache ignores organization.json (not a directory)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u8-'));
  try {
    // Seed one legit project and an extra top-level file (organization.json at root)
    seedPrefixPortfolio(dir, [
      { org: 'acme', project: 'app', component: 'main', ticket_prefix: 'ACM' },
    ]);
    // Write a misleading root-level organization.json with ticket_prefix
    writeFileSync(join(dir, 'organization.json'), JSON.stringify({ ticket_prefix: 'BAD' }));
    const cache = await buildPrefixCache(dir);
    // Only ACM from the legit project entry
    assert.strictEqual(cache.size, 1);
    const entry = cache.get('acme/app/main');
    assert.ok(entry);
    assert.strictEqual(entry.prefix, 'ACM');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TP-U9: buildPrefixCache defaults ticketStart to 1 when ticket_start is absent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tp-u9-'));
  try {
    seedPrefixPortfolio(dir, [
      { org: 'acme', project: 'app', component: 'main', ticket_prefix: 'ACM' },
    ]);
    const cache = await buildPrefixCache(dir);
    const entry = cache.get('acme/app/main');
    assert.ok(entry);
    assert.strictEqual(entry.ticketStart, 1, 'ticketStart defaults to 1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — HTTP integration: live server with prefix-configured portfolio
// ─────────────────────────────────────────────────────────────────────────────

let serverProc = null;
let dbName = null;
let workDir = null;
const PORT = TEST_PORT;

before(async () => {
  dbName = testDbName(PORT);
  workDir = mkdtempSync(join(tmpdir(), 'tp-server-'));

  // Seed portfolio with:
  //   neuronic/cortex/main → prefix GEN, ticketStart 10000
  //   ticari/architect/main → no prefix (fallback W-)
  const portfolioDir = join(workDir, 'portfolio');
  mkdirSync(portfolioDir, { recursive: true });
  seedPrefixPortfolio(portfolioDir, [
    { org: 'neuronic', project: 'cortex', component: 'main', ticket_prefix: 'GEN', ticket_start: 10000 },
    { org: 'ticari', project: 'architect', component: 'main' },
  ]);

  await createTestDb(dbName);
  killAnyOnPort(PORT);
  await waitPortFree(PORT);

  serverProc = spawnTestServer(PORT, workDir, dbName);
  await waitReadyAndVerify(PORT, serverProc.pid);
});

after(async () => {
  if (serverProc) await gracefulKill(serverProc.pid);
  if (dbName) await dropTestDb(dbName).catch(() => {});
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // Purge all work items before each test so sequence-dependent tests are isolated.
  // Use the test purge-all endpoint (global, no worker header).
  const resp = await fetch(`http://127.0.0.1:${PORT}/api/test/purge-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error(`purge-all failed: ${resp.status}`);
});

test('TP-1: POST /api/work-items with neuronic/cortex/main yields GEN-NNNNN id', async () => {
  const { status, body } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-1 cortex item',
      status: 'draft',
      priority: 'medium',
      project_key: 'neuronic/cortex/main',
    }),
  });
  assert.strictEqual(status, 201, `expected 201 Created, got ${status}`);
  assert.ok(body.id, 'response must have id');
  assert.match(body.id, /^GEN-\d+$/, `id "${body.id}" must match GEN-\\d+`);
});

test('TP-1b: GET /api/work-items/:id returns the GEN item', async () => {
  const { body: created } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-1b cortex item',
      status: 'draft',
      priority: 'medium',
      project_key: 'neuronic/cortex/main',
    }),
  });
  assert.match(created.id, /^GEN-\d+$/, `created.id "${created.id}" must match GEN-\\d+`);

  const { status, body } = await api(PORT, `work-items/${created.id}`);
  assert.strictEqual(status, 200);
  assert.strictEqual(body.id, created.id);
});

test('TP-2: second POST to neuronic/cortex/main increments sequence by exactly 1', async () => {
  // Peek at the current sequence to find the expected next ID before creating.
  const { body: peek0 } = await api(PORT, 'sequences/next?project_key=neuronic%2Fcortex%2Fmain');
  const expectedFirst = peek0.next_work_item_id; // e.g. GEN-10000
  assert.match(expectedFirst, /^GEN-\d+$/, `peek must return GEN-\\d+`);
  const firstNum = parseInt(expectedFirst.slice('GEN-'.length), 10);
  const expectedSecond = `GEN-${firstNum + 1}`;

  // First item — consumes expectedFirst
  const { status: s1, body: first } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-2 first',
      status: 'draft',
      priority: 'medium',
      project_key: 'neuronic/cortex/main',
    }),
  });
  assert.strictEqual(s1, 201);
  assert.strictEqual(first.id, expectedFirst, `first id must be ${expectedFirst}, got ${first.id}`);

  // Second item — must be expectedFirst + 1
  const { body: second } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-2 second',
      status: 'draft',
      priority: 'medium',
      project_key: 'neuronic/cortex/main',
    }),
  });
  assert.strictEqual(second.id, expectedSecond, `second id must be ${expectedSecond}, got ${second.id}`);
});

test('TP-3: POST /api/work-items with ticari/architect/main (no prefix configured) yields W-NNN id', async () => {
  const { status, body } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-3 architect item',
      status: 'draft',
      priority: 'medium',
      project_key: 'ticari/architect/main',
    }),
  });
  assert.strictEqual(status, 201, `expected 201 Created, got ${status}`);
  assert.ok(body.id, 'response must have id');
  assert.match(body.id, /^W-\d+$/, `id "${body.id}" must match W-\\d+`);
});

test('TP-4: both GEN-NNNNN and W-NNN routing patterns return 200 concurrently', async () => {
  // Create one GEN item and one W item
  const { body: genItem } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-4 cortex',
      status: 'draft',
      priority: 'medium',
      project_key: 'neuronic/cortex/main',
    }),
  });
  const { body: wItem } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-4 architect',
      status: 'draft',
      priority: 'medium',
      project_key: 'ticari/architect/main',
    }),
  });

  assert.match(genItem.id, /^GEN-\d+$/);
  assert.match(wItem.id, /^W-\d+$/);

  // Both must be fetchable concurrently
  const [genFetch, wFetch] = await Promise.all([
    api(PORT, `work-items/${genItem.id}`),
    api(PORT, `work-items/${wItem.id}`),
  ]);
  assert.strictEqual(genFetch.status, 200, `GET ${genItem.id} should return 200`);
  assert.strictEqual(wFetch.status, 200, `GET ${wItem.id} should return 200`);
});

test('TP-5: GET /api/sequences/next?project_key=neuronic/cortex/main returns next_work_item_id matching GEN-NNNNN', async () => {
  const { status, body } = await api(PORT, 'sequences/next?project_key=neuronic%2Fcortex%2Fmain');
  assert.strictEqual(status, 200);
  assert.ok(body.next_work_item_id, 'response must have next_work_item_id');
  assert.match(
    body.next_work_item_id,
    /^GEN-\d+$/,
    `next_work_item_id "${body.next_work_item_id}" must match GEN-\\d+`,
  );
});

test('TP-5b: GET /api/sequences/next without project_key returns W-NNN', async () => {
  const { status, body } = await api(PORT, 'sequences/next');
  assert.strictEqual(status, 200);
  assert.match(body.next_work_item_id, /^W-\d+$/);
});

test('TP-6: POST /api/server/action { action: "reload-prefix-cache" } returns ok with loaded count', async () => {
  const { status, body } = await api(PORT, 'server/action', {
    method: 'POST',
    body: JSON.stringify({ action: 'reload-prefix-cache' }),
  });
  assert.ok(status === 200 || status === 202, `expected 200 or 202, got ${status}`);
  assert.strictEqual(body.ok, true, 'response body must have ok: true');
  assert.ok(typeof body.loaded === 'number' && body.loaded >= 0, `loaded must be a non-negative integer, got ${body.loaded}`);
});

test('TP-7: sequence state persists — peek matches allocation and increments correctly', async () => {
  // Peek at the current next ID before any allocation in this test.
  const { body: peek0 } = await api(PORT, 'sequences/next?project_key=neuronic%2Fcortex%2Fmain');
  const expectedFirst = peek0.next_work_item_id;
  assert.match(expectedFirst, /^GEN-\d+$/);
  const firstNum = parseInt(expectedFirst.slice('GEN-'.length), 10);

  // Create first item — must consume expectedFirst.
  const { body: first } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-7 first',
      status: 'draft',
      priority: 'medium',
      project_key: 'neuronic/cortex/main',
    }),
  });
  assert.strictEqual(first.id, expectedFirst, `first item must be ${expectedFirst}, got ${first.id}`);

  // Peek after first allocation — must show next_val = firstNum + 1.
  const expectedSecond = `GEN-${firstNum + 1}`;
  const { body: peek1 } = await api(PORT, 'sequences/next?project_key=neuronic%2Fcortex%2Fmain');
  assert.strictEqual(
    peek1.next_work_item_id,
    expectedSecond,
    `peek after first item must be ${expectedSecond}, got ${peek1.next_work_item_id}`,
  );

  // Create second item — sequence must NOT reset; must be firstNum + 1.
  const { body: second } = await api(PORT, 'work-items', {
    method: 'POST',
    body: JSON.stringify({
      title: 'TP-7 second',
      status: 'draft',
      priority: 'medium',
      project_key: 'neuronic/cortex/main',
    }),
  });
  assert.strictEqual(second.id, expectedSecond, `second id must be ${expectedSecond}, got ${second.id}`);
});
