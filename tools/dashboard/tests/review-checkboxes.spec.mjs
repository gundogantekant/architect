import { test, expect } from './fixtures.mjs';
import { seedTerminal } from './helpers.mjs';

test.describe('Review checkboxes — RCE2E', () => {

  let terminalId;
  test.beforeEach(async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    terminalId = t.id;
    await page.goto('/');
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
  });

  test('RCE2E-1: Renders', async ({ page }) => {
    const reviewRow = page.locator(`#terminal-${terminalId} .terminal-review-row`);
    await expect(reviewRow).toBeAttached();

    const boardCheckbox = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    const humanCheckbox = page.locator(`#terminal-${terminalId} input[aria-label="human reviewed"]`);
    await expect(boardCheckbox).toBeAttached();
    await expect(humanCheckbox).toBeAttached();

    const labels = page.locator(`#terminal-${terminalId} .terminal-review-row .review-checkbox-label`);
    await expect(labels).toHaveCount(2);
  });

  test('RCE2E-2: Check persists across reload', async ({ page }) => {
    const boardCheckbox = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    await boardCheckbox.check();
    await expect(boardCheckbox).toBeChecked();

    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    const boardCheckboxAfterReload = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    await expect(boardCheckboxAfterReload).toBeChecked();
  });

  test('RCE2E-3: Uncheck persists', async ({ page }) => {
    await page.evaluate(([id, state]) => {
      localStorage.setItem('termReviewState', JSON.stringify({ [id]: state }));
    }, [terminalId, { boardReviewed: true, humanReviewed: false }]);

    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    const boardCheckbox = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    await expect(boardCheckbox).toBeChecked();

    await boardCheckbox.uncheck();
    await expect(boardCheckbox).not.toBeChecked();

    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    const boardCheckboxAfterReload = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    await expect(boardCheckboxAfterReload).not.toBeChecked();
  });

  test('RCE2E-4: Per-terminal isolation', async ({ page }) => {
    const secondTerminal = await seedTerminal({ skip_seed: true });
    const secondTerminalId = secondTerminal.id;

    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForSelector(`#terminal-${secondTerminalId}`, { timeout: 10_000 });

    const firstBoardCheckbox = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    await firstBoardCheckbox.check();
    await expect(firstBoardCheckbox).toBeChecked();

    const secondBoardCheckbox = page.locator(`#terminal-${secondTerminalId} input[aria-label="board reviewed"]`);
    await expect(secondBoardCheckbox).not.toBeChecked();
  });

  test('RCE2E-5: No API call on toggle', async ({ page }) => {
    const apiRequests = [];
    page.on('request', req => {
      if (req.url().includes('/api/')) {
        apiRequests.push(req.url());
      }
    });

    // Wait for any in-flight polling requests to settle before measuring
    await page.waitForTimeout(500);

    // Clear any requests that occurred during setup/polling
    apiRequests.length = 0;

    const boardCheckbox = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    await boardCheckbox.check();

    // Allow a brief tick for any async request that might fire due to the toggle
    await page.waitForTimeout(200);

    // Filter out background polling requests (heartbeat, active list, etc.)
    const nonPollingRequests = apiRequests.filter(url =>
      !url.includes('/api/terminal/active') &&
      !url.includes('/api/dispatch/active') &&
      !url.includes('/api/server/status') &&
      !url.includes('/api/sessions/active') &&
      !url.includes('/api/backlog')
    );
    expect(nonPollingRequests).toHaveLength(0);
  });

  test('RCE2E-6: Note row unaffected', async ({ page }) => {
    const noteRow = page.locator(`#terminal-${terminalId} .terminal-note-row`);
    await expect(noteRow).toBeAttached();

    await page.locator(`#terminal-${terminalId} .terminal-header`).hover();
    const notePlaceholder = page.locator(`#terminal-${terminalId} .terminal-note-empty`);
    await expect(notePlaceholder).toBeVisible();
    await expect(notePlaceholder).toHaveText('✎ label session');
  });

  test('RCE2E-7: Clicking checkbox does not collapse the panel', async ({ page }) => {
    const panel = page.locator(`#terminal-${terminalId}`);
    await expect(panel).not.toHaveClass(/collapsed/);

    const boardCheckbox = page.locator(`#terminal-${terminalId} input[aria-label="board reviewed"]`);
    await boardCheckbox.check();

    await expect(panel).not.toHaveClass(/collapsed/);
  });

});
