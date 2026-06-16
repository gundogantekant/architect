import { test, expect } from './fixtures.mjs';
import { seedTerminal, api } from './helpers.mjs';

test.describe('Label truncation @fast', () => {
  let terminalId;

  test.beforeEach(async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    terminalId = t.id;
    await page.goto('/');
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
  });

  test('LT-1: terminal panel renders auto-title in [data-main-title]', async ({ page }) => {
    const mainTitle = page.locator(`#terminal-${terminalId} [data-main-title]`);
    await expect(mainTitle).toBeVisible();
    const text = await mainTitle.textContent();
    expect(text.length).toBeGreaterThan(0);
  });

  test('LT-2: saving a 150-char note updates [data-main-title] and keeps title attr as original', async ({ page }) => {
    const mainTitle = page.locator(`#terminal-${terminalId} [data-main-title]`);
    const originalTitle = await mainTitle.getAttribute('data-original-title');

    const longNote = 'n'.repeat(150);

    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    await page.locator(`#terminal-${terminalId} .terminal-note-input`).fill(longNote);
    await page.locator(`#terminal-${terminalId} .terminal-note-save-btn`).click();

    await expect(mainTitle).toHaveText(longNote, { timeout: 5_000 });
    expect(await mainTitle.getAttribute('title')).toBe(originalTitle);
  });

  test('LT-3: [data-main-title] does not overflow its container', async ({ page }) => {
    const longNote = 'label '.repeat(25).trim();
    await api(`terminal/${terminalId}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: longNote }),
    });
    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    const noOverflow = await page.locator(`#terminal-${terminalId} [data-main-title]`).evaluate((el) => {
      return el.clientWidth <= (el.parentElement?.clientWidth ?? Infinity) + 1;
    });
    expect(noOverflow).toBe(true);
  });

  test('LT-4: clearing note restores [data-main-title] to original auto-title', async ({ page }) => {
    await api(`terminal/${terminalId}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'temp label' }),
    });
    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    const mainTitle = page.locator(`#terminal-${terminalId} [data-main-title]`);
    const originalTitle = await mainTitle.getAttribute('data-original-title');

    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    await page.locator(`#terminal-${terminalId} .terminal-note-clear-btn`).click();

    await expect(mainTitle).toHaveText(originalTitle, { timeout: 5_000 });
  });
});
