import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL;

test('detach 200: returns DetachReport shape', async ({ request }) => {
  // Seed a minimal portfolio entry via test endpoint
  const seed = await request.post(`${BASE}/_test/seed-portfolio`, {
    data: { org: 'test-org', project: 'test-proj', component: 'main', path: '/tmp/test-proj' }
  });
  expect(seed.ok()).toBeTruthy();

  const res = await request.delete(`${BASE}/api/portfolio/test-org/test-proj/main`);
  expect(res.ok()).toBeTruthy();
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

test('detach 404: unknown component returns 404', async ({ request }) => {
  const res = await request.delete(`${BASE}/api/portfolio/no-org/no-proj/no-comp`);
  expect(res.status()).toBe(404);
});

test('detach 409: active dispatch blocks detach when kill_active_dispatches: false', async ({ request }) => {
  const seed = await request.post(`${BASE}/_test/seed-portfolio`, {
    data: { org: 'test-org2', project: 'test-proj2', component: 'main', path: '/tmp/test-proj2' }
  });
  expect(seed.ok()).toBeTruthy();

  // Seed an active dispatch for this project
  const dispSeed = await request.post(`${BASE}/_test/seed-dispatch`, {
    data: { status: 'running', project_key: 'test-org2/test-proj2/main' }
  });
  expect(dispSeed.ok()).toBeTruthy();

  const res = await request.delete(`${BASE}/api/portfolio/test-org2/test-proj2/main`, {
    data: { kill_active_dispatches: false }
  });
  expect(res.status()).toBe(409);
});
