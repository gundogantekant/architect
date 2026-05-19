import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

test.describe('Sessions page @fast', () => {
  test('SP-1: sessions sidebar link is present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-nav="all-sessions"], [onclick*="all-sessions"]')).toBeVisible();
  });

  test('SP-2: GET /api/sessions/all returns array', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/sessions/all`);
    expect(res.ok).toBeTruthy();
    const data = await res.json();
    expect(Array.isArray(data)).toBeTruthy();
  });
});
