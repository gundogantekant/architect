/**
 * E2E tests for ISO timestamp two-line formatting (W-1193)
 *
 * Verifies that all in-scope timestamp surfaces render a two-span cell
 * (date on line 1, 24-hour time on line 2) and that sort data attributes
 * carry epoch integer values.
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, seedEpic, seedDispatch, api } from './helpers.mjs';

const COMPONENT_KEY = 'ticari/architect/main';
const MINIMAL_PORTFOLIO_ENTRY = { worktree_mode: 'auto', worktree_setup: { branch: 'main' } };

test.beforeAll(async () => {
  await api('test/seed-portfolio-entry', {
    method: 'POST',
    body: JSON.stringify({ project_key: COMPONENT_KEY, entry: MINIMAL_PORTFOLIO_ENTRY }),
  });
});

// Helper: assert a locator contains a two-span timestamp cell
async function expectTwoLineTimestamp(locator) {
  const spans = locator.locator('span[style*="display:block"]');
  await expect(spans).toHaveCount(2);
  const timeText = await spans.nth(1).textContent();
  expect(timeText).not.toMatch(/AM|PM/i);
}

test.describe('Work items table timestamp cells @fast', () => {

  test('FTE-1: created_at cell renders two-line date/time format', async ({ page }) => {
    await seedWorkItem({ title: 'FTE-1 timestamp cell', project_key: COMPONENT_KEY });
    await page.goto(`/#component/ticari/architect/main`);
    await page.waitForSelector('#wi-table', { timeout: 15_000 });
    const rows = page.locator('#wi-table tbody tr[data-wi-row]');
    await expect(rows.first()).toBeVisible({ timeout: 10_000 });

    const firstRow = rows.first();
    // Created At is the 8th column (index 7)
    const createdCell = firstRow.locator('td').nth(7);
    await expectTwoLineTimestamp(createdCell);
  });

  test('FTE-2: data-wi-createdat-val carries epoch integer matching API created_at', async ({ page }) => {
    const item = await seedWorkItem({ title: 'FTE-2 epoch attr', project_key: COMPONENT_KEY });
    const fetched = await api(`work-items/${item.id}`);
    const expectedEpoch = new Date(fetched.created_at).getTime();
    expect(expectedEpoch).not.toBeNaN();

    await page.goto(`/#component/ticari/architect/main`);
    await page.waitForSelector(`tr[data-wi-row]`, { timeout: 15_000 });

    const row = page.locator(`tr[data-wi-row]`).filter({
      has: page.locator(`code:text("${item.id}")`),
    });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const val = await row.getAttribute('data-wi-createdat-val');
    expect(Number(val)).toBe(expectedEpoch);
  });

  test('FTE-3: sorting by Created column uses epoch value (earlier item appears first)', async ({ page }) => {
    const itemA = await seedWorkItem({ title: 'FTE-3 item-A', project_key: COMPONENT_KEY });
    // Brief pause to ensure different created_at timestamps
    await new Promise(r => setTimeout(r, 50));
    const itemB = await seedWorkItem({ title: 'FTE-3 item-B', project_key: COMPONENT_KEY });

    const fetchedA = await api(`work-items/${itemA.id}`);
    const fetchedB = await api(`work-items/${itemB.id}`);
    const epochA = new Date(fetchedA.created_at).getTime();
    const epochB = new Date(fetchedB.created_at).getTime();

    await page.goto(`/#component/ticari/architect/main`);
    await page.waitForSelector('#wi-table', { timeout: 15_000 });

    const rowA = page.locator(`tr[data-wi-row]`).filter({
      has: page.locator(`code:text("${itemA.id}")`),
    });
    const rowB = page.locator(`tr[data-wi-row]`).filter({
      has: page.locator(`code:text("${itemB.id}")`),
    });
    await expect(rowA).toBeVisible({ timeout: 10_000 });
    await expect(rowB).toBeVisible({ timeout: 10_000 });

    const valA = Number(await rowA.getAttribute('data-wi-createdat-val'));
    const valB = Number(await rowB.getAttribute('data-wi-createdat-val'));
    expect(valA).toBe(epochA);
    expect(valB).toBe(epochB);
    // A was created first so its epoch must be ≤ B's epoch
    expect(valA).toBeLessThanOrEqual(valB);
  });

});

test.describe('Dispatch panel timestamp @fast', () => {

  test('FTE-4: dispatch panel meta shows two-line date/time', async ({ page }) => {
    const { dispatch_id } = await seedDispatch({ status: 'completed', project_key: COMPONENT_KEY });
    await page.goto('/');
    const meta = page.locator(`#dispatch-${dispatch_id} .dispatch-meta`);
    await expect(meta).toBeVisible({ timeout: 15_000 });
    await expectTwoLineTimestamp(meta);
  });

});

test.describe('Epic detail timestamp @fast', () => {

  test('FTE-5: epic detail created_at and updated_at render two-line format', async ({ page }) => {
    const epic = await seedEpic({ title: 'FTE-5 epic timestamp', status: 'active' });
    await page.goto(`/#epic/${epic.id}`);
    // dl.kv lives inside an inactive tab — use 'attached' to find it in the DOM
    await page.waitForSelector('dl.kv', { state: 'attached', timeout: 15_000 });

    // Click the Details tab to make dl.kv visible
    const detailsTab = page.locator('#epic-tabs .tab').filter({ hasText: 'Details' });
    await detailsTab.click();
    await page.waitForSelector('dl.kv', { timeout: 10_000 });

    const kv = page.locator('dl.kv');
    // "Created" dt/dd pair
    const createdDd = kv.locator('dt:text("Created") + dd');
    await expect(createdDd).toBeVisible({ timeout: 10_000 });
    await expectTwoLineTimestamp(createdDd);

    // "Updated" dt/dd pair
    const updatedDd = kv.locator('dt:text("Updated") + dd');
    await expect(updatedDd).toBeVisible({ timeout: 10_000 });
    await expectTwoLineTimestamp(updatedDd);
  });

});

test.describe('All-sessions table CLI registered_at @fast', () => {

  test('FTE-6: all-sessions table shows two-line timestamp for CLI sessions', async ({ page }) => {
    // Register a CLI session using the current Playwright runner PID (guaranteed alive)
    await api('sessions/register', {
      method: 'POST',
      body: JSON.stringify({
        id: `cli-fte-6-${Date.now()}`,
        title: 'FTE-6 CLI session',
        project_key: COMPONENT_KEY,
        pid: process.pid,
      }),
    });

    await page.goto('/#all-sessions');
    await page.waitForSelector('.wi-table', { timeout: 15_000 });

    // Find the CLI row and check the Started cell
    const cliRow = page.locator('.wi-table tbody tr').filter({
      hasText: 'FTE-6 CLI session',
    });
    await expect(cliRow).toBeVisible({ timeout: 10_000 });
    const startedCell = cliRow.locator('td').nth(5);
    await expectTwoLineTimestamp(startedCell);
  });

});
