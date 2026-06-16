import { test, expect } from './fixtures.mjs';
import { seedTerminal } from './helpers.mjs';

test.describe('Terminal session id footer @fast', () => {

  const SESSION_ID = '11111111-2222-3333-4444-555555555555';

  test('TSI-1: footer .session-id-copy shows the claude session id', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true, status: 'running', claude_session_id: SESSION_ID });

    await page.goto('/');
    await page.waitForSelector(`#terminal-${t.id}`, { timeout: 10_000 });
    const tag = page.locator(`#terminal-${t.id} .session-id-copy`);
    await expect(tag).toHaveText(SESSION_ID, { timeout: 10_000 });
  });

  test('TSI-2: only one .session-id-copy exists after a refresh cycle', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true, status: 'running', claude_session_id: SESSION_ID });

    await page.goto('/');
    await page.waitForSelector(`#terminal-${t.id} .session-id-copy`, { timeout: 10_000 });
    // restoreTerminals runs on a 10s interval and syncs the session id back onto
    // the existing panel; wait through one cycle to confirm no duplicate tag.
    await page.waitForTimeout(11_000);
    const count = await page.locator(`#terminal-${t.id} .session-id-copy`).count();
    expect(count).toBe(1);
  });

});
