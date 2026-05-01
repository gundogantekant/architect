import { test, expect } from './fixtures.mjs';

test('PP-1: PORTFOLIO_DIR env override is honored', async () => {
  const port = process.env.TEST_SERVER_PORT;
  const r = await fetch(`http://localhost:${port}/api/_diag/portfolio-path`);
  expect(r.status).toBe(200);
  const { path } = await r.json();
  expect(path).toBeTruthy();
  expect(typeof path).toBe('string');
  // Must NOT be the repo-local portfolio (which would not survive worktrees)
  expect(path).not.toContain('/Documents/architect/portfolio');
});

test('PP-2: server starts cleanly when portfolio dir does not yet exist', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#sidebar')).toBeVisible({ timeout: 5000 });
});
