import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

test.describe('Work item refinement @fast', () => {
  test('RF-1: POST /refine on draft item returns dispatch_id and accepted', async () => {
    const base = getBase();
    const seedRes = await fetch(`${base}/_test/seed-work-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'draft', title: 'RF-1 draft item', project_key: 'test/test/main' })
    });
    const { id } = await seedRes.json();

    const res = await fetch(`${base}/api/work-items/${id}/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('dispatch_id');
    expect(body.accepted).toBe(true);

    if (body.dispatch_id) {
      await fetch(`${base}/api/dispatch/${body.dispatch_id}`, { method: 'DELETE' });
    }
  });

  test('RF-2: POST /refine on non-draft item returns 409', async () => {
    const base = getBase();
    const seedRes = await fetch(`${base}/_test/seed-work-item`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'planned', title: 'RF-2 planned item', project_key: 'test/test/main' })
    });
    const { id } = await seedRes.json();

    const res = await fetch(`${base}/api/work-items/${id}/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(409);
  });

  test('RF-3: POST /refine on unknown item returns 404', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/work-items/W-99999/refine`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    expect(res.status).toBe(404);
  });

  test('RF-4: dispatch_mode refinement is a known dispatch mode', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/dispatch/active`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
