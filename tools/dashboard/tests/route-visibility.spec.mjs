import { test, expect } from './fixtures.mjs';
import { seedTerminal } from './helpers.mjs';

test.describe('Route visibility @fast', () => {
  let terminalId;

  test.beforeEach(async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    terminalId = t.id;
    await page.goto('/');
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
  });

  test('RV-1: panels are hidden on a clean route after repeated placeSessionPanels calls', async ({ page }) => {
    await page.goto('/#time-report');
    await page.evaluate(() => {
      window.placeSessionPanels();
      window.placeSessionPanels();
      window.placeSessionPanels();
    });
    await page.waitForTimeout(100);

    const allHidden = await page.evaluate((tid) => {
      const panel = document.getElementById(`terminal-${tid}`);
      if (!panel) return true;
      return panel.offsetParent === null;
    }, terminalId);

    expect(allHidden).toBe(true);
  });

  test('RV-2: panels are visible again after navigating to a session-aware route', async ({ page }) => {
    await page.goto('/#time-report');
    await page.evaluate(() => {
      window.placeSessionPanels();
      window.placeSessionPanels();
      window.placeSessionPanels();
    });
    await page.waitForTimeout(100);

    await page.goto('/#agents');
    await page.waitForTimeout(300);

    const panelVisible = await page.evaluate((tid) => {
      const panel = document.getElementById(`terminal-${tid}`);
      if (!panel) return false;
      return panel.offsetParent !== null;
    }, terminalId);

    expect(panelVisible).toBe(true);
  });
});
