/**
 * Access control tests (E4 + E7).
 *
 * E4 — IP blocklist API lifecycle: block → list → unblock → list empty; malformed IP
 *      rejected (400); self-lockout guard (blocking the requester's own IP → 400).
 *      Runs against the shared worker-fixture server (loopback client).
 *
 * E7 — Host/Origin access guard: a request with a foreign Host header → 403; a loopback
 *      Host → ok; a mutating POST with a foreign Origin → 403; same-origin POST → ok.
 *      The guard exempts loopback as the recovery path, so E7 spawns a DEDICATED server
 *      with ARCHITECT_GUARD_DISABLE_LOOPBACK_EXEMPT=1 (test-only) so the loopback test
 *      client is treated as remote and the denial branches are reachable.
 *
 * Headless — no browser required.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs / fixtures.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';
import {
  BASE_PORT, createTestDb, dropTestDb, testDbName, killAnyOnPort,
  waitPortFree, waitReadyAndVerify, gracefulKill, spawnTestServer,
} from './server-utils.mjs';
import { join } from 'node:path';
import { ROOT } from './server-utils.mjs';
import { rmSync } from 'node:fs';
import http from 'node:http';

/**
 * Raw HTTP request with full control over the Host/Origin headers — Node's fetch (undici)
 * forbids overriding the Host header, so the E7 guard tests use node:http directly.
 */
function rawRequest(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? Buffer.from(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================
// E4 — IP blocklist API lifecycle
// ============================================================
test.describe('E4: IP blocklist API @fast', () => {
  test('E4-1: block → list contains → unblock → list empty', async () => {
    const base = getBase();
    const ip = '203.0.113.7'; // TEST-NET-3, never a real client

    // block
    const blockResp = await fetch(`${base}/api/access/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, reason: 'E4 test' }),
    });
    expect(blockResp.ok).toBe(true);

    // list contains
    const listed = await (await fetch(`${base}/api/access/blocklist`)).json();
    expect(listed.some(r => r.ip === ip)).toBe(true);

    // unblock
    const delResp = await fetch(`${base}/api/access/block/${encodeURIComponent(ip)}`, { method: 'DELETE' });
    expect(delResp.ok).toBe(true);

    // list no longer contains it
    const after = await (await fetch(`${base}/api/access/blocklist`)).json();
    expect(after.some(r => r.ip === ip)).toBe(false);
  });

  test('E4-2: DELETE malformed IP → 400', async () => {
    const resp = await fetch(`${getBase()}/api/access/block/${encodeURIComponent('not-an-ip')}`, { method: 'DELETE' });
    expect(resp.status).toBe(400);
  });

  test('E4-4: POST malformed IP → 400 and not stored (XSS guard)', async () => {
    const base = getBase();
    const badIps = ['not-an-ip', '1.1.1.1" onmouseover=alert(1)'];

    for (const ip of badIps) {
      const resp = await fetch(`${base}/api/access/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip, reason: 'E4-4 malformed' }),
      });
      expect(resp.status).toBe(400);

      // The malformed value must not have been persisted to the blocklist.
      const listed = await (await fetch(`${base}/api/access/blocklist`)).json();
      expect(listed.some(r => r.ip === ip)).toBe(false);
    }
  });

  test('E4-3: blocking the requester own (loopback) IP → 400 (self-lockout guard)', async () => {
    // The test client connects from 127.0.0.1; the blocklist refuses to block loopback.
    const resp = await fetch(`${getBase()}/api/access/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: '127.0.0.1' }),
    });
    expect(resp.status).toBe(400);
  });
});

// ============================================================
// E7 — Host / Origin access guard (dedicated no-loopback-exempt server)
// ============================================================
test.describe('E7: Host/Origin access guard @fast', () => {
  // Dedicated server, well above the SPEC_FILES port range to avoid collisions.
  const PORT = BASE_PORT + 500;
  const workDir = join(ROOT, 'tmp', 'pw-access-e7');
  const dbName = testDbName(PORT);
  let proc;

  test.beforeAll(async () => {
    await createTestDb(dbName);
    killAnyOnPort(PORT);
    await waitPortFree(PORT);
    proc = spawnTestServer(PORT, workDir, dbName, {
      ARCHITECT_GUARD_DISABLE_LOOPBACK_EXEMPT: '1',
    });
    await waitReadyAndVerify(PORT, proc.pid);
  });

  test.afterAll(async () => {
    if (proc) await gracefulKill(proc.pid);
    await dropTestDb(dbName).catch(() => {});
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  });

  test('E7-1: foreign Host header → 403', async () => {
    const resp = await rawRequest(PORT, {
      path: '/api/server/status',
      headers: { Host: 'evil.com' },
    });
    expect(resp.status).toBe(403);
  });

  test('E7-2: loopback Host header → ok', async () => {
    const resp = await rawRequest(PORT, {
      path: '/api/server/status',
      headers: { Host: `127.0.0.1:${PORT}` },
    });
    expect(resp.status).toBe(200);
  });

  test('E7-3: POST with foreign Origin → 403', async () => {
    const resp = await rawRequest(PORT, {
      method: 'POST',
      path: '/api/work-items',
      headers: {
        'Content-Type': 'application/json',
        Host: `127.0.0.1:${PORT}`,
        Origin: 'http://evil.com',
      },
      body: JSON.stringify({ title: 'E7-3 cross-origin item', status: 'draft', priority: 'medium', project_key: 'ticari/architect/main' }),
    });
    expect(resp.status).toBe(403);
  });

  test('E7-4: same-origin POST → not blocked by the guard', async () => {
    const resp = await rawRequest(PORT, {
      method: 'POST',
      path: '/api/work-items',
      headers: {
        'Content-Type': 'application/json',
        Host: `127.0.0.1:${PORT}`,
        Origin: `http://127.0.0.1:${PORT}`,
      },
      body: JSON.stringify({ title: 'E7-4 same-origin item', status: 'draft', priority: 'medium', project_key: 'ticari/architect/main' }),
    });
    // Same-origin passes the guard; the request itself succeeds (200/201).
    expect(resp.status).not.toBe(403);
    expect(resp.status).toBeLessThan(300);
  });
});
