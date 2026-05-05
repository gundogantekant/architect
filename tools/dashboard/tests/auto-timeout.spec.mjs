import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

test.describe('Dispatch auto-timeout @fast', () => {
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
});
