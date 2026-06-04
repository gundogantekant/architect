/**
 * E2E tests: terminal and dispatch session creation resilience when PostgreSQL
 * save fails. Verifies that sessions spawn correctly and appear in active lists
 * even when the initial DB persist throws.
 *
 * Uses the one-shot fault-injection endpoint (POST /api/test/simulate-db-save-error)
 * to induce a DB save failure without stopping the DB server.
 */
import { test, expect } from './fixtures.mjs';
import { getBase, api } from './helpers.mjs';

const TEST_PROJECT_KEY = 'test/test/main';

async function seedRegistryEntry(base) {
  const rootRes = await fetch(`${base}/api/test/root-path`);
  const { root } = await rootRes.json();
  await fetch(`${base}/api/test/seed-registry-entry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_key: TEST_PROJECT_KEY, project_path: root }),
  });
}

async function fetchActiveTerminals(base) {
  const res = await fetch(`${base}/api/terminal/active`);
  return res.json();
}

async function armDbSaveError(base) {
  const res = await fetch(`${base}/api/test/simulate-db-save-error`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status).toBe(200);
}

async function createShellTerminal(base) {
  return fetch(`${base}/api/terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_key: TEST_PROJECT_KEY, agentType: 'shell', skip_seed: true }),
  });
}

test.describe('Terminal DB Resilience', () => {

  test.beforeEach(async () => {
    const base = getBase();
    await seedRegistryEntry(base);
  });

  test('DB-1: POST /api/terminal returns 200 with terminal_id on success', async () => {
    const base = getBase();
    const res = await createShellTerminal(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.terminal_id).toBeTruthy();

    const active = await fetchActiveTerminals(base);
    const found = active.find(t => t.id === body.terminal_id);
    expect(found).toBeTruthy();

    await fetch(`${base}/api/terminal/${body.terminal_id}`, { method: 'DELETE' });
  });

  test('DB-2: terminal creation succeeds even when DB save throws', async () => {
    const base = getBase();
    await armDbSaveError(base);

    const res = await createShellTerminal(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.terminal_id).toBeTruthy();
    expect(body.error).toBeUndefined();

    const active = await fetchActiveTerminals(base);
    const found = active.find(t => t.id === body.terminal_id);
    expect(found).toBeTruthy();

    await fetch(`${base}/api/terminal/${body.terminal_id}`, { method: 'DELETE' });
  });

  test('DB-3: after one-shot fires, subsequent terminal creation succeeds normally', async () => {
    const base = getBase();
    await armDbSaveError(base);

    const firstRes = await createShellTerminal(base);
    const firstBody = await firstRes.json();
    if (firstBody.terminal_id) {
      await fetch(`${base}/api/terminal/${firstBody.terminal_id}`, { method: 'DELETE' });
    }

    const res = await createShellTerminal(base);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.terminal_id).toBeTruthy();

    await fetch(`${base}/api/terminal/${body.terminal_id}`, { method: 'DELETE' });
  });

  test('DB-4: simulate-db-save-error endpoint returns 200 and arms the flag in test environment', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/test/simulate-db-save-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.armed).toBe(true);

    // Consume the armed shot so subsequent tests are not affected
    await createShellTerminal(base);
  });

});
