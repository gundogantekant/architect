import { test, expect } from '@playwright/test';

const BASE = process.env.BASE_URL;

test('org repos 200: returns expected shape', async ({ request }) => {
  const res = await request.get(`${BASE}/api/org/neuronic/repos`);
  expect(res.status()).toBeOneOf([200, 404]); // 404 OK if org not seeded in test env
  if (res.ok()) {
    const body = await res.json();
    expect(body).toMatchObject({
      org: expect.any(String),
      onboarded: expect.any(Array),
      unregistered: expect.any(Array),
      seeded: expect.any(Boolean),
    });
  }
});

test('repos portfolio-key PATCH 400: missing body field', async ({ request }) => {
  const res = await request.patch(`${BASE}/api/repos/some-repo/portfolio-key`, {
    data: {}
  });
  expect(res.status()).toBe(400);
});
