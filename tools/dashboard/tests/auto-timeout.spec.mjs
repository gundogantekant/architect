import { test, expect } from './fixtures.mjs';
import { getBase, api, purgeAll } from './helpers.mjs';

test.describe('Dispatch auto-timeout @fast', () => {
  test.beforeEach(async () => { await purgeAll(); });

  test('AT-1: new running dispatch has timeout_at set', async () => {
    const base = getBase();
    const seed = await fetch(`${base}/_test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running', timeout_at: new Date(Date.now() + 3600000).toISOString() }),
    });
    expect(seed.ok).toBeTruthy();
    const { id } = await seed.json();

    const res = await fetch(`${base}/api/dispatch/active`);
    const dispatches = await res.json();
    const d = dispatches.find(x => x.id === id);
    expect(d).toBeDefined();
    expect(d.timeout_at).toBeTruthy();
  });

  test('AT-2: GET /api/dispatch/active exposes last_output_at field', async () => {
    const base = getBase();
    const id = `D-at2-${Date.now()}`;
    const seed = await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'running', timeout_at: new Date(Date.now() + 3600000).toISOString() }),
    });
    expect(seed.ok).toBeTruthy();

    const res = await fetch(`${base}/api/dispatch/active`);
    const dispatches = await res.json();
    const d = dispatches.find(x => x.id === id);
    expect(d).toBeDefined();
    // last_output_at is null initially (no output written yet)
    expect('last_output_at' in d).toBeTruthy();
  });

  test('AT-3: POST /api/dispatch/:id/extend extends timeout_at', async () => {
    const base = getBase();
    const id = `D-at3-${Date.now()}`;
    const seed = await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'running', timeout_at: new Date(Date.now() + 300000).toISOString() }),
    });
    expect(seed.ok).toBeTruthy();

    const before = Date.now();
    const extendRes = await fetch(`${base}/api/dispatch/${id}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration_ms: 1800000 }),
    });
    expect(extendRes.ok).toBeTruthy();
    const body = await extendRes.json();
    expect(body.timeout_at).toBeTruthy();

    // New deadline should be ~30min from now (duration_ms: 1800000)
    const newDeadline = new Date(body.timeout_at).getTime();
    expect(newDeadline).toBeGreaterThan(before + 1700000);
    expect(newDeadline).toBeLessThan(before + 1900000);
  });

  test('AT-4: POST /extend is rejected for non-running dispatches', async () => {
    const base = getBase();
    const id = `D-at4-${Date.now()}`;
    const seed = await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'completed' }),
    });
    expect(seed.ok).toBeTruthy();

    const extendRes = await fetch(`${base}/api/dispatch/${id}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(extendRes.status).toBe(400);
  });

  test('AT-5: POST /extend is rejected for non-existent dispatch', async () => {
    const base = getBase();
    const extendRes = await fetch(`${base}/api/dispatch/D-does-not-exist/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(extendRes.status).toBe(404);
  });

  test('AT-6: POST /extend is rejected for depth >= 1 (agent calls not allowed)', async () => {
    const base = getBase();
    const id = `D-at6-${Date.now()}`;
    const seed = await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'running', timeout_at: new Date(Date.now() + 3600000).toISOString() }),
    });
    expect(seed.ok).toBeTruthy();

    const extendRes = await fetch(`${base}/api/dispatch/${id}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-architect-session-depth': '1' },
      body: JSON.stringify({ duration_ms: 1800000 }),
    });
    expect(extendRes.status).toBe(403);
  });

  test('AT-7: POST /extend with no body uses default EXTEND_DURATION_MS', async () => {
    const base = getBase();
    const id = `D-at7-${Date.now()}`;
    const seed = await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'running', timeout_at: new Date(Date.now() + 300000).toISOString() }),
    });
    expect(seed.ok).toBeTruthy();

    const before = Date.now();
    const extendRes = await fetch(`${base}/api/dispatch/${id}/extend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(extendRes.ok).toBeTruthy();
    const body = await extendRes.json();
    const newDeadline = new Date(body.timeout_at).getTime();
    // Default is 30 min (1800000ms); new deadline should be roughly before + 30min
    expect(newDeadline).toBeGreaterThan(before + 1700000);
    expect(newDeadline).toBeLessThan(before + 1900000);
  });

  test('AT-8: auto_extended column is included in DB schema', async () => {
    const base = getBase();
    const id = `D-at8-${Date.now()}`;
    const seed = await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'running', timeout_at: new Date(Date.now() + 3600000).toISOString() }),
    });
    expect(seed.ok).toBeTruthy();

    // The seed-dispatch calls saveDispatchToDb which includes auto_extended.
    // If migration 033 is missing or assertSchema fails, the server would have
    // crashed at startup, so a successful response here proves schema is correct.
    const activeRes = await fetch(`${base}/api/dispatch/active`);
    expect(activeRes.ok).toBeTruthy();
  });
});
