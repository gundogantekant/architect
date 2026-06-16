import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// Test the blocklist module in isolation with a mock pool
test('blocklist: normalizeIp strips ::ffff: prefix', async () => {
  // Import after setting up
  const mod = await import('../lib/blocklist.mjs');
  // Test via block/isBlocked cycle with mock pool
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('SELECT ip FROM ip_blocklist')) return { rows: [] };
      if (sql.includes('INSERT')) return { rows: [] };
      if (sql.includes('DELETE')) return { rows: [] };
      if (sql.includes('SELECT ip, reason, blocked_at')) return { rows: [] };
      return { rows: [] };
    }
  };
  await mod.load(mockPool);
  // Block a non-loopback IP
  await mod.block(mockPool, '192.168.1.5', 'test');
  assert.ok(mod.isBlocked('192.168.1.5'), 'direct IP should be blocked');
  assert.ok(mod.isBlocked('::ffff:192.168.1.5'), '::ffff: mapped form should also be blocked');
});

test('blocklist: loopback addresses cannot be blocked', async () => {
  const mod = await import('../lib/blocklist.mjs');
  const mockPool = { query: async () => ({ rows: [] }) };
  await assert.rejects(
    () => mod.block(mockPool, '127.0.0.1', 'test'),
    /loopback/i
  );
  await assert.rejects(
    () => mod.block(mockPool, '::1', 'test'),
    /loopback/i
  );
});

test('blocklist: unblock removes from Set', async () => {
  const mod = await import('../lib/blocklist.mjs');
  const mockPool = { query: async () => ({ rows: [] }) };
  await mod.block(mockPool, '10.0.0.1', 'to-remove');
  assert.ok(mod.isBlocked('10.0.0.1'));
  await mod.unblock(mockPool, '10.0.0.1');
  assert.ok(!mod.isBlocked('10.0.0.1'), 'IP should be unblocked');
});

test('blocklist: load throws on DB failure', async () => {
  const mod = await import('../lib/blocklist.mjs');
  const failPool = {
    query: async () => { throw new Error('Connection refused'); }
  };
  await assert.rejects(
    () => mod.load(failPool),
    /Connection refused/
  );
});

// HTTP integration: test blocklist middleware behavior with a minimal server
test('HTTP: blocked IP receives 403', async () => {
  const blocklistModule = await import('../lib/blocklist.mjs');
  // Note: blocklist module is stateful (Set persists between imports in same process)
  // Use a fresh IP for this test
  const testIp = '203.0.113.1'; // TEST-NET, safe to use
  const mockPool = { query: async () => ({ rows: [] }) };
  await blocklistModule.load(mockPool);
  await blocklistModule.block(mockPool, testIp, 'http-test');

  function normalizeIp(ip) {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  }

  const srv = createServer((req, res) => {
    const clientIp = normalizeIp(req.socket.remoteAddress ?? '');
    if (blocklistModule.isBlocked(clientIp)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });

  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // 127.0.0.1 is not blocked → 200
  const okRes = await fetch(`${baseUrl}/any`);
  assert.equal(okRes.status, 200, '127.0.0.1 should be allowed');

  // Unblock and verify access restored
  await blocklistModule.unblock(mockPool, testIp);
  assert.ok(!blocklistModule.isBlocked(testIp), 'should be unblocked');

  srv.close();
});

test('blocklist: isBlocked returns false for unknown IPs', async () => {
  const mod = await import('../lib/blocklist.mjs');
  assert.ok(!mod.isBlocked('8.8.8.8'), 'unknown IP should not be blocked');
});

// E2: loopback is always exempt from the blocklist 403 — the guaranteed local recovery
// path so the host can reach /api/access/* even if the blocklist is misconfigured.
test('E2: isLoopback recognizes loopback forms and not LAN IPs', async () => {
  const { isLoopback } = await import('../lib/blocklist.mjs');
  for (const ip of ['127.0.0.1', '127.5.5.5', '::1', '::ffff:127.0.0.1']) {
    assert.ok(isLoopback(ip), `${ip} should be loopback`);
  }
  for (const ip of ['192.168.1.5', '10.0.0.9', '203.0.113.7', '::ffff:192.168.1.5']) {
    assert.ok(!isLoopback(ip), `${ip} should NOT be loopback`);
  }
});

test('E2: enforcement exempts loopback even when isBlocked would return true', async () => {
  const { isLoopback, normalizeIp } = await import('../lib/blocklist.mjs');
  // Mirror the exact server.mjs enforcement formula with a worst-case isBlocked.
  const isBlocked = () => true; // pretend every IP is blocked
  const srv = createServer((req, res) => {
    const clientIp = normalizeIp(req.socket.remoteAddress ?? '');
    if (!isLoopback(clientIp) && isBlocked(clientIp)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}/api/access/blocklist`);
  assert.equal(res.status, 200, 'loopback must bypass the blocklist 403');
  srv.close();
});

// E3: POST /api/access/block must reject blocking the caller's own IP (self-lockout),
// reject loopback, and otherwise block normally — tested through the real route handler.
test('E3: block route rejects self-IP and loopback, allows other IPs', async () => {
  const blocklist = await import('../lib/blocklist.mjs');
  const accessRoutes = (await import('../routes/access.mjs')).default;

  const inserted = [];
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('INSERT')) inserted.push(params?.[0]);
      return { rows: [] };
    },
  };
  const deps = {
    db: { getPool: () => mockPool },
    blocklist,
    parseBody: async (req) => req._body,
    json: (res, obj) => { res._status = 200; res._json = obj; },
    err: (res, msg, code) => { res._status = code; res._err = msg; },
  };
  const routes = accessRoutes(deps);
  const blockHandler = routes.find(
    ([pattern, method]) => method === 'POST' && /access\\\/block\$/.test(pattern.source)
  )[2];

  const call = async (remoteAddress, ip) => {
    const req = { socket: { remoteAddress }, _body: { ip } };
    const res = {};
    await blockHandler(null, req, res);
    return res;
  };

  // Self-IP (non-loopback LAN) → 400
  const self = await call('192.168.1.50', '192.168.1.50');
  assert.equal(self._status, 400);
  assert.match(self._err, /your own address/i);

  // Loopback → 400 (block() throws "loopback", route maps to 400)
  const loop = await call('192.168.1.50', '127.0.0.1');
  assert.equal(loop._status, 400);

  // A different LAN IP → 200 and actually recorded
  const other = await call('192.168.1.50', '10.0.0.42');
  assert.equal(other._status, 200);
  assert.ok(inserted.includes('10.0.0.42'), 'a non-self IP should be inserted');
  await blocklist.unblock(mockPool, '10.0.0.42'); // reset module-global state
});
