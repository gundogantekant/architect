/**
 * Contract tests for SSE and WebSocket heartbeat hardening (W-1203).
 *
 * Written BEFORE implementation — tests must fail (red) until the heartbeat
 * intervals are wired up in routes/dispatch.mjs and ws-router.mjs.
 */

import { test as baseTest, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { getBase } from './helpers.mjs';
import {
  ROOT, BASE_PORT,
  killAnyOnPort, waitPortFree, waitReadyAndVerify, gracefulKill,
  spawnTestServer, createTestDb, dropTestDb, testDbName,
} from './server-utils.mjs';
import { SPEC_FILES } from './global-setup.mjs';

// Short interval so tests complete in well under 5 seconds
const TEST_HEARTBEAT_MS = 500;

// Override _workerPort to inject a short HEARTBEAT_INTERVAL_MS into the test server.
// All other fixtures (_autoPurge, _disableAutoDismiss, _defaultExpanded) are inherited.
const test = baseTest.extend({
  _workerPort: [async ({}, use, workerInfo) => {
    const specName = workerInfo.project.name.replace(/\/(chromium|firefox)$/, '');
    const idx = SPEC_FILES.indexOf(specName);
    if (idx < 0) throw new Error(`Unknown spec "${specName}" — add it to SPEC_FILES in global-setup.mjs`);
    const port = BASE_PORT + idx;
    const workDir = join(ROOT, 'tmp', `pw-s${idx}`);
    const dbName = testDbName(port);

    await createTestDb(dbName);
    killAnyOnPort(port);
    await waitPortFree(port);
    const proc = spawnTestServer(port, workDir, dbName, { HEARTBEAT_INTERVAL_MS: String(TEST_HEARTBEAT_MS) });

    await waitReadyAndVerify(port, proc.pid);
    process.env.TEST_SERVER_PORT = String(port);
    await use(port);

    await gracefulKill(proc.pid);
    await dropTestDb(dbName).catch(() => {});
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, { scope: 'worker', auto: true }],
});

export { expect };

// ---------------------------------------------------------------------------
// Helper: read from an SSE stream until `predicate` returns true or timeout.
// Returns { found: bool, received: string }.
// ---------------------------------------------------------------------------
async function collectSse(url, predicate, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let received = '';
  let found = false;

  try {
    const response = await fetch(url, { signal: ac.signal });
    if (!response.ok) return { found: false, received: `HTTP ${response.status}` };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      if (predicate(received)) {
        found = true;
        break;
      }
    }
    try { reader.cancel(); } catch {}
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
  }

  return { found, received };
}

test.describe('Heartbeat hardening @fast', () => {

  test('HB-1: SSE dispatch stream emits keep-alive comment frame when dispatch is idle', async () => {
    const base = getBase();
    const dispatchId = `D-hb-sse-${Date.now()}`;

    const seed = await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dispatchId, status: 'running' }),
    });
    expect(seed.ok).toBeTruthy();

    const { found, received } = await collectSse(
      `${base}/api/dispatch/${dispatchId}/stream`,
      (data) => data.includes(': keep-alive'),
      TEST_HEARTBEAT_MS * 4,
    );

    expect(
      found,
      `Expected keep-alive SSE comment frame within ${TEST_HEARTBEAT_MS * 4}ms.\nReceived:\n${received}`,
    ).toBe(true);
  });

  test('HB-2: WebSocket terminal subscriber receives ping frame within heartbeat window', async () => {
    const base = getBase();
    const wsBase = base.replace('http://', 'ws://');

    const seedResp = await fetch(`${base}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running' }),
    });
    expect(seedResp.ok).toBeTruthy();
    const { terminal_id } = await seedResp.json();

    const pingReceived = await new Promise((resolve) => {
      const ws = new WebSocket(`${wsBase}/api/terminal/${terminal_id}/ws`);
      const timer = setTimeout(() => { ws.terminate(); resolve(false); }, TEST_HEARTBEAT_MS * 4);

      ws.on('ping', () => {
        clearTimeout(timer);
        ws.terminate();
        resolve(true);
      });

      ws.on('error', () => { clearTimeout(timer); resolve(false); });
    });

    expect(
      pingReceived,
      `Expected ping frame within ${TEST_HEARTBEAT_MS * 4}ms of WebSocket connect`,
    ).toBe(true);
  });

});
