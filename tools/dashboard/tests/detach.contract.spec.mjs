import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

test.describe('Detach API contracts @fast', () => {

  test('DC-1: detach 200 returns DetachReport shape', async () => {
    const base = getBase();
    const seed = await fetch(`${base}/_test/seed-portfolio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org: 'test-org', project: 'test-proj', component: 'main', path: '/tmp/test-proj' }),
    });
    expect(seed.ok).toBeTruthy();

    const res = await fetch(`${base}/api/portfolio/test-org/test-proj/main`, { method: 'DELETE' });
    expect(res.ok).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({
      portfolio_key: 'test-org/test-proj/main',
      steps: expect.objectContaining({
        portfolio_json_removed: expect.any(Boolean),
        registry_entry_removed: expect.any(Boolean),
        work_items_cancelled: expect.objectContaining({ count: expect.any(Number) }),
      }),
      errors: expect.any(Array),
    });
  });

  test('DC-2: detach 404 for unknown component', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/portfolio/no-org/no-proj/no-comp`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  test('DC-3: detach 409 when active dispatch and kill_active_dispatches: false', async () => {
    const base = getBase();
    const seed = await fetch(`${base}/_test/seed-portfolio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ org: 'test-org3', project: 'test-proj3', component: 'main', path: '/tmp/test-proj3' }),
    });
    expect(seed.ok).toBeTruthy();

    const dispSeed = await fetch(`${base}/_test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'running', project_key: 'test-org3/test-proj3/main' }),
    });
    expect(dispSeed.ok).toBeTruthy();

    const res = await fetch(`${base}/api/portfolio/test-org3/test-proj3/main`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kill_active_dispatches: false }),
    });
    expect(res.status).toBe(409);
  });

});
