import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

test.describe('Org Repos API contracts @fast', () => {

  test('OR-1: GET /api/org/:org/repos returns expected shape', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/org/neuronic/repos`);
    // 404 is acceptable when org has no repo_sync_config rows in test DB
    expect([200, 404]).toContain(res.status);
    if (res.ok) {
      const body = await res.json();
      expect(body).toMatchObject({
        org: expect.any(String),
        onboarded: expect.any(Array),
        unregistered: expect.any(Array),
        seeded: expect.any(Boolean),
      });
    }
  });

  test('OR-2: PATCH /api/repos/:name/portfolio-key 400 when portfolio_key key absent', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/repos/some-repo/portfolio-key`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

});
