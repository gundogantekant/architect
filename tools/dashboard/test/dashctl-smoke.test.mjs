// Regression smoke test for the dashctl.sh launch path.
//
// Context: the LAN access-control change shipped `nohup ARCHITECT_HOST=... node ...`,
// where the env assignment after `nohup` is parsed as the program name, so the server
// never started (`nohup: ARCHITECT_HOST=127.0.0.1: No such file or directory`). No
// existing test invoked the launch path, so the suite stayed green while the dashboard
// was fully down. This test guards that exact regression hermetically — it exercises the
// shell launch *form* with a stub server (no PostgreSQL, no real server.mjs), plus a
// static guard on dashctl.sh and a unit test of the bind-host derivation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = join(__dirname, '..');
const DASHCTL = join(DASHBOARD_DIR, 'dashctl.sh');
const NODE = process.execPath;

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

async function waitForStatus(port, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/server/status`);
      if (res.ok) return res;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

// A stand-in for server.mjs: binds the host from ARCHITECT_HOST (so we can assert a
// 0.0.0.0 bind is reachable via loopback) and reports it on /api/server/status.
const STUB = `
import { createServer } from 'node:http';
const idx = process.argv.indexOf('--port');
const port = Number(process.argv[idx + 1]);
const host = process.env.ARCHITECT_HOST ?? '127.0.0.1';
createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, host }));
}).listen(port, host);
`;

// Run a launch line through /bin/sh exactly as dashctl backgrounds it, returning the pid.
function launch(line) {
  const out = spawnSync('/bin/sh', ['-c', `${line}\necho $!`], { encoding: 'utf8' });
  return out.stdout.trim().split('\n').pop().trim();
}

test('dashctl static guard: env assignment is before nohup, not after', () => {
  const src = readFileSync(DASHCTL, 'utf8');
  assert.ok(
    !/nohup\s+ARCHITECT_HOST=/.test(src),
    'dashctl.sh must NOT contain the broken `nohup ARCHITECT_HOST=...` form'
  );
  assert.ok(
    /export ARCHITECT_HOST=/.test(src) && /nohup\s+"\$NODE_BIN"/.test(src),
    'dashctl.sh must export ARCHITECT_HOST before a `nohup "$NODE_BIN"` launch'
  );
});

test('E1: correct launch form starts a live listener with ARCHITECT_HOST propagated', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashctl-smoke-'));
  const stub = join(dir, 'stub.mjs');
  const log = join(dir, 'out.log');
  writeFileSync(stub, STUB);
  const port = await freePort();
  try {
    const pid = launch(
      `export ARCHITECT_HOST="127.0.0.1"; nohup "${NODE}" "${stub}" --port ${port} >> "${log}" 2>&1 &`
    );
    const res = await waitForStatus(port);
    assert.ok(res, 'stub server should be reachable on its port');
    const body = await res.json();
    assert.equal(body.host, '127.0.0.1', 'ARCHITECT_HOST must reach the process env');

    const logText = readFileSync(log, 'utf8');
    assert.ok(!logText.includes('nohup:'), `launch log must have no nohup error: ${logText}`);
    assert.ok(pid && Number(pid) > 0, '$! must capture a real pid');
    process.kill(Number(pid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E1 (negative): the broken `nohup VAR=...` form fails to launch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashctl-broken-'));
  const stub = join(dir, 'stub.mjs');
  const log = join(dir, 'out.log');
  writeFileSync(stub, STUB);
  const port = await freePort();
  try {
    // Reproduce the original regression and prove this test discriminates against it.
    launch(`nohup ARCHITECT_HOST="127.0.0.1" "${NODE}" "${stub}" --port ${port} >> "${log}" 2>&1 &`);
    const res = await waitForStatus(port, 1500);
    assert.equal(res, null, 'broken form must NOT produce a live listener');
    const logText = readFileSync(log, 'utf8');
    assert.ok(logText.includes('nohup:'), 'broken form must log a nohup error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E4: a 0.0.0.0 bind is reachable via loopback (health check stays valid)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dashctl-bindall-'));
  const stub = join(dir, 'stub.mjs');
  const log = join(dir, 'out.log');
  writeFileSync(stub, STUB);
  const port = await freePort();
  try {
    const pid = launch(
      `export ARCHITECT_HOST="0.0.0.0"; nohup "${NODE}" "${stub}" --port ${port} >> "${log}" 2>&1 &`
    );
    // Loopback health check must succeed even though the server bound 0.0.0.0.
    const res = await waitForStatus(port);
    assert.ok(res, 'server bound to 0.0.0.0 must be reachable via 127.0.0.1');
    const body = await res.json();
    assert.equal(body.host, '0.0.0.0', 'server should have bound the wide address');
    process.kill(Number(pid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveBindHost: loopback by default, 0.0.0.0 only on explicit opt-in', async () => {
  const { resolveBindHost } = await import('../constants.mjs');
  assert.equal(resolveBindHost({}), '127.0.0.1', 'default is loopback-only');
  assert.equal(resolveBindHost({ ARCHITECT_BIND_ALL: '1' }), '0.0.0.0', 'opt-in via BIND_ALL');
  assert.equal(resolveBindHost({ ARCHITECT_HOST: '0.0.0.0' }), '0.0.0.0', 'explicit wide host');
  assert.equal(
    resolveBindHost({ ARCHITECT_HOST: '192.168.1.5' }),
    '192.168.1.5',
    'explicit host is honored verbatim'
  );
  // A LAN IP in DASHCTL_HOST must not auto-expose: dashctl decides the bind, and only
  // passes ARCHITECT_HOST when opted in — so without ARCHITECT_HOST the default holds.
  assert.equal(resolveBindHost({ DASHCTL_HOST: '192.168.1.5' }), '127.0.0.1');
});
