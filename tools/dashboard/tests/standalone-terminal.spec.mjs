/**
 * Standalone mobile terminal page tests — Stream B
 *
 * ST-1: GET /t/<valid-id> → 200, text/html, body contains the xterm mount container.
 * ST-2: GET /t/<bogus-id> → 404.
 * ST-3: Browser navigation renders the xterm element and the mobile key bar buttons.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedTerminal } from './helpers.mjs';

test.describe('Standalone mobile terminal @fast', () => {

  test('ST-1: GET /t/<valid-id> returns 200 HTML with the xterm mount', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const resp = await fetch(`${getBase()}/t/${t.id}`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    const body = await resp.text();
    expect(body).toContain('id="term-container"');
    expect(body).toContain('data-key="esc"');
  });

  test('ST-2: GET /t/<bogus-id> returns 404', async () => {
    const resp = await fetch(`${getBase()}/t/T-does-not-exist`);
    expect(resp.status).toBe(404);
  });

  test('ST-3: page renders xterm and key bar buttons', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    await page.goto(getBase() + '/t/' + t.id);
    await page.waitForSelector('.xterm', { timeout: 15_000 });
    expect(await page.locator('.xterm').count()).toBeGreaterThan(0);
    await expect(page.locator('[data-key="esc"]')).toBeVisible();
    await expect(page.locator('[data-key="ctrl"]')).toBeVisible();
    await expect(page.locator('[data-key="up"]')).toBeVisible();
    await expect(page.locator('[data-key="enter"]')).toBeVisible();
  });

});
