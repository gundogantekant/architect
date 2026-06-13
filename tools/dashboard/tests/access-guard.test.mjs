import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

/**
 * E6: unit tests for the pure access guard (lib/access-guard.mjs).
 *
 * The guard is the no-auth dashboard's defence-in-depth layer: loopback exemption,
 * Host-header validation (DNS-rebinding), optional IP allow-list, blocklist deny-list,
 * and same-origin enforcement for mutating methods (CSRF). All stateful collaborators are
 * injected so these tests run with no server and no DB.
 */

function normalizeIp(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}
function isLoopback(ip) {
  const n = normalizeIp(ip);
  return n === '::1' || /^127\./.test(n);
}

// Base config: server LAN IP is 192.168.1.50; nothing blocked; no allow-lists.
function makeConfig(overrides = {}) {
  return {
    allowedHosts: [],
    allowIps: [],
    serverLanIps: ['192.168.1.50'],
    isBlocked: () => false,
    isLoopback,
    normalizeIp,
    ...overrides,
  };
}

let evaluateRequest;
test.before(async () => {
  ({ evaluateRequest } = await import(join(ROOT, 'tools/dashboard/lib/access-guard.mjs')));
});

test('AG-1: loopback client is exempt and overrides everything', () => {
  const cfg = makeConfig({ isBlocked: () => true, allowIps: ['10.0.0.1'] });
  const v = evaluateRequest(
    { clientIp: '127.0.0.1', host: 'evil.com', origin: 'http://evil.com', method: 'POST', path: '/api/dispatch' },
    cfg,
  );
  assert.equal(v.allow, true, 'loopback bypasses blocklist, allow-list, host check, and CSRF');
});

test('AG-1b: ::1 (IPv6 loopback) is exempt', () => {
  const v = evaluateRequest(
    { clientIp: '::1', host: 'evil.com', method: 'GET', path: '/' },
    makeConfig(),
  );
  assert.equal(v.allow, true);
});

test('AG-2: unknown Host → deny 403', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: 'evil.com', method: 'GET', path: '/' },
    makeConfig(),
  );
  assert.equal(v.allow, false);
  assert.equal(v.status, 403);
  assert.match(v.reason, /host/i);
});

test('AG-3: loopback Host name from a remote client → allow', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '127.0.0.1:3777', method: 'GET', path: '/' },
    makeConfig(),
  );
  assert.equal(v.allow, true);
});

test('AG-4: server LAN IP as Host → allow', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '192.168.1.50:3777', method: 'GET', path: '/' },
    makeConfig(),
  );
  assert.equal(v.allow, true);
});

test('AG-5: ARCHITECT_ALLOWED_HOSTS entry → allow', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: 'dash.local:3777', method: 'GET', path: '/' },
    makeConfig({ allowedHosts: ['dash.local'] }),
  );
  assert.equal(v.allow, true);
});

test('AG-6: cross-origin mutation → deny 403', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '192.168.1.50:3777', origin: 'http://evil.com', method: 'POST', path: '/api/dispatch' },
    makeConfig(),
  );
  assert.equal(v.allow, false);
  assert.equal(v.status, 403);
  assert.match(v.reason, /cross-origin/i);
});

test('AG-7: no-Origin mutation → allow (programmatic/curl)', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '192.168.1.50:3777', origin: undefined, method: 'POST', path: '/api/dispatch' },
    makeConfig(),
  );
  assert.equal(v.allow, true);
});

test('AG-8: same-origin mutation → allow', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '192.168.1.50:3777', origin: 'http://192.168.1.50:3777', method: 'POST', path: '/api/dispatch' },
    makeConfig(),
  );
  assert.equal(v.allow, true);
});

test('AG-9: ARCHITECT_ALLOW_IPS set — in-list non-loopback client → allow', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.42', host: '192.168.1.50:3777', method: 'GET', path: '/' },
    makeConfig({ allowIps: ['192.168.1.42'] }),
  );
  assert.equal(v.allow, true);
});

test('AG-10: ARCHITECT_ALLOW_IPS set — out-of-list non-loopback client → deny 403', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '192.168.1.50:3777', method: 'GET', path: '/' },
    makeConfig({ allowIps: ['192.168.1.42'] }),
  );
  assert.equal(v.allow, false);
  assert.equal(v.status, 403);
});

test('AG-10b: ARCHITECT_ALLOW_IPS CIDR — in-subnet client → allow', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.77', host: '192.168.1.50:3777', method: 'GET', path: '/' },
    makeConfig({ allowIps: ['192.168.1.0/24'] }),
  );
  assert.equal(v.allow, true);
});

test('AG-11: isBlocked client → deny 403', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '192.168.1.50:3777', method: 'GET', path: '/' },
    makeConfig({ isBlocked: (ip) => normalizeIp(ip) === '192.168.1.99' }),
  );
  assert.equal(v.allow, false);
  assert.equal(v.status, 403);
  assert.match(v.reason, /block/i);
});

test('AG-12: loopback bypasses allow-list, deny-list, and host check', () => {
  const cfg = makeConfig({
    allowIps: ['10.0.0.1'],
    isBlocked: () => true,
  });
  const v = evaluateRequest(
    { clientIp: '127.0.0.5', host: 'unknown.example', method: 'DELETE', path: '/api/access/block/1.2.3.4' },
    cfg,
  );
  assert.equal(v.allow, true);
});

test('AG-13: ::ffff: mapped LAN IP as Host matches serverLanIps', () => {
  const v = evaluateRequest(
    { clientIp: '192.168.1.99', host: '::ffff:192.168.1.50', method: 'GET', path: '/' },
    makeConfig(),
  );
  assert.equal(v.allow, true);
});
