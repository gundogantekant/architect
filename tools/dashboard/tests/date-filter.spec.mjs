/**
 * Date Filter Contract Tests (W-1192)
 *
 * TDD contract tests for date range filter on work-items, epic task list, and agents view.
 *
 * DF-1: Work-items Last 7d — recent item visible, 60-day-old item hidden; count badge shown
 * DF-2: Work-items Custom range — custom inputs visible when preset=custom, hidden on Today
 * DF-3: Work-items persistence — Last 30d preset survives page reload via wi_filters prefs
 * DF-4: Server-side filter — GET /api/backlog?from=today&to=today excludes 60-day-old item
 * DF-5: Epic surface — Last 7d on epic detail, ef_filters persisted separately from wi_filters
 * DF-6: Agents surface — Last 7d encoded in URL hash as agent_date, survives navigation reload
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api, seedWorkItem, seedDispatch, backdateWorkItem, seedEpic } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';
const MINIMAL_PORTFOLIO_ENTRY = { worktree_mode: 'explicit', worktree_setup: { branch: 'main' } };

function todayUTCString() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function daysAgoISO(n) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - n)).toISOString();
}

test.describe('Date Filter @fast', () => {

  test.beforeAll(async () => {
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: PROJECT_KEY, entry: MINIMAL_PORTFOLIO_ENTRY }),
    });
  });

  test.beforeEach(async () => {
    // Purge all items including backdated ones (standard purgeAll only removes items from last 2h)
    await api('test/purge-work-items', { method: 'POST' });
  });

  // DF-1: Last 7d filter shows recent item, hides 60-day-old item; count badge reflects active filter
  test('DF-1: Last 7d filter on work-items hides old item and shows count badge', async ({ page }) => {
    const recent = await seedWorkItem({ title: 'DF-1 recent item', project_key: PROJECT_KEY });
    const old = await seedWorkItem({ title: 'DF-1 old item', project_key: PROJECT_KEY });
    await backdateWorkItem(old.id, daysAgoISO(60));

    await page.goto(`/#component/${PROJECT_KEY}`);
    await expect(page.locator('#wi-filter-bar')).toBeVisible({ timeout: 15_000 });

    // Wait for both items to render (default status filter shows draft items)
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-1 recent item' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-1 old item' })).toBeVisible({ timeout: 5_000 });

    await page.selectOption('#wi-filter-date-preset', '7d');

    // Recent item visible, old item hidden
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-1 recent item' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-1 old item' })).not.toBeVisible({ timeout: 5_000 });

    // Filter-count badge shows "X of Y tasks" when filter is active
    await expect(page.locator('#wi-filter-count')).toContainText('of', { timeout: 3_000 });
  });

  // DF-2: Custom preset shows date inputs; switching to Today hides them
  test('DF-2: Custom date inputs visible only when preset=custom', async ({ page }) => {
    const recent = await seedWorkItem({ title: 'DF-2 recent item', project_key: PROJECT_KEY });
    const old = await seedWorkItem({ title: 'DF-2 old item', project_key: PROJECT_KEY });
    await backdateWorkItem(old.id, daysAgoISO(60));

    await page.goto(`/#component/${PROJECT_KEY}`);
    await expect(page.locator('#wi-filter-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-2 recent item' })).toBeVisible({ timeout: 10_000 });

    // Switch to Custom preset
    await page.selectOption('#wi-filter-date-preset', 'custom');

    // Custom date inputs must be visible (hidden attribute removed)
    await expect(page.locator('#wi-date-custom-range')).not.toHaveAttribute('hidden');

    // Enter range that covers only yesterday–today (excludes 60-day-old item)
    const now = new Date();
    const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)).toISOString().slice(0, 10);
    await page.fill('#wi-filter-date-from', yesterday);
    await page.fill('#wi-filter-date-to', todayUTCString());

    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-2 recent item' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-2 old item' })).not.toBeVisible({ timeout: 5_000 });

    // Switch to Today — custom date inputs must be hidden
    await page.selectOption('#wi-filter-date-preset', 'today');
    await expect(page.locator('#wi-date-custom-range')).toHaveAttribute('hidden', '');
  });

  // DF-3: Last 30d preset persists across page reload via wi_filters prefs
  test('DF-3: Last 30d preset survives page reload', async ({ page }) => {
    const recent = await seedWorkItem({ title: 'DF-3 recent item', project_key: PROJECT_KEY });
    const old = await seedWorkItem({ title: 'DF-3 old item', project_key: PROJECT_KEY });
    await backdateWorkItem(old.id, daysAgoISO(60));

    await page.goto(`/#component/${PROJECT_KEY}`);
    await expect(page.locator('#wi-filter-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-3 recent item' })).toBeVisible({ timeout: 10_000 });

    // Apply Last 30d filter and wait for it to save to prefs
    const [_saveDF3] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/settings/preferences') && resp.status() === 200),
      page.selectOption('#wi-filter-date-preset', '30d'),
    ]);
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-3 old item' })).not.toBeVisible({ timeout: 5_000 });

    // Reload and verify preset is restored and filter is applied
    await page.reload();
    await expect(page.locator('#wi-filter-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#wi-filter-date-preset')).toHaveValue('30d', { timeout: 8_000 });
    await expect(page.locator('[data-wi-row]').filter({ hasText: 'DF-3 old item' })).not.toBeVisible({ timeout: 5_000 });
  });

  // DF-4: Server-side parameterized date filter via GET /api/backlog?from=&to=
  test('DF-4: GET /api/backlog?from=today&to=today excludes 60-day-old item', async () => {
    const recent = await seedWorkItem({ title: 'DF-4 recent item', project_key: PROJECT_KEY });
    const old = await seedWorkItem({ title: 'DF-4 old item', project_key: PROJECT_KEY });
    await backdateWorkItem(old.id, daysAgoISO(60));

    const today = todayUTCString();
    const backlog = await api(`backlog?from=${today}&to=${today}`);
    const allItems = Object.values(backlog.projects).flatMap(p => p.items);

    const foundRecent = allItems.find(i => i.id === recent.id);
    const foundOld = allItems.find(i => i.id === old.id);

    expect(foundRecent, 'recent item created today must be included').toBeDefined();
    expect(foundOld, '60-day-old item must be excluded from today UTC filter').toBeUndefined();
  });

  // DF-5: Epic surface — Last 7d on epic detail; ef_filters persisted separately from wi_filters
  test('DF-5: Last 7d on epic detail persists in separate ef_filters key', async ({ page }) => {
    const epic = await seedEpic({ title: 'DF-5 epic' });
    const recentItem = await seedWorkItem({ title: 'DF-5 recent task', project_key: PROJECT_KEY, epic_id: epic.id });
    const oldItem = await seedWorkItem({ title: 'DF-5 old task', project_key: PROJECT_KEY, epic_id: epic.id });
    await backdateWorkItem(oldItem.id, daysAgoISO(60));

    await page.goto(`/#epic/${epic.id}`);
    await expect(page.locator('#epic-filter-bar')).toBeVisible({ timeout: 15_000 });

    // Both tasks visible initially
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'DF-5 recent task' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'DF-5 old task' })).toBeVisible({ timeout: 5_000 });

    // Apply Last 7d filter and wait for preferences save to complete
    const [_saveDF5] = await Promise.all([
      page.waitForResponse(resp => resp.url().includes('/api/settings/preferences') && resp.status() === 200),
      page.selectOption('#ef-filter-date-preset', '7d'),
    ]);

    await expect(page.locator('[data-ef-row]').filter({ hasText: 'DF-5 recent task' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'DF-5 old task' })).not.toBeVisible({ timeout: 5_000 });

    // Reload — ef_filters must restore the filter
    await page.reload();
    await expect(page.locator('#epic-filter-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#ef-filter-date-preset')).toHaveValue('7d', { timeout: 8_000 });
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'DF-5 old task' })).not.toBeVisible({ timeout: 5_000 });

    // Verify ef_filters is stored in a SEPARATE key from wi_filters
    const prefs = await api('settings/preferences');
    expect(prefs.ef_filters, 'ef_filters key must be set').toBeDefined();
    const efPrefs = JSON.parse(prefs.ef_filters);
    expect(efPrefs.epic_date_preset).toBe('7d');
    // wi_filters must not contain epic_date_preset
    if (prefs.wi_filters) {
      const wiPrefs = JSON.parse(prefs.wi_filters);
      expect(wiPrefs.epic_date_preset, 'epic date preset must not bleed into wi_filters').toBeUndefined();
    }
  });

  // DF-6: Agents surface — Last 7d encoded in URL hash as agent_date; filter survives URL reload
  test('DF-6: Last 7d agent filter encoded in hash as agent_date and survives reload', async ({ page }) => {
    await seedDispatch({
      id: `DF6-recent-${Date.now()}`,
      title: 'DF-6 recent agent',
      project_key: PROJECT_KEY,
      started_at: new Date().toISOString(),
    });
    await seedDispatch({
      id: `DF6-old-${Date.now()}`,
      title: 'DF-6 old agent',
      project_key: PROJECT_KEY,
      started_at: daysAgoISO(60),
    });

    await page.goto('/#agents');
    await expect(page.locator('.agents-filter-bar')).toBeVisible({ timeout: 15_000 });

    // Both tiles visible initially
    await expect(page.locator('.agent-tile').filter({ hasText: 'DF-6 recent agent' })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.agent-tile').filter({ hasText: 'DF-6 old agent' })).toBeVisible({ timeout: 5_000 });

    // Select Last 7d
    await page.selectOption('#agents-date-preset', '7d');

    // Old tile filtered out, recent tile still visible
    await expect(page.locator('.agent-tile').filter({ hasText: 'DF-6 recent agent' })).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('.agent-tile').filter({ hasText: 'DF-6 old agent' })).not.toBeVisible({ timeout: 5_000 });

    // URL hash must include agent_date=7d
    await expect(page).toHaveURL(/agent_date=7d/, { timeout: 3_000 });

    // Navigate directly to the hash URL — filter must be re-applied from URL
    const hashUrl = await page.evaluate(() => window.location.href);
    await page.goto(hashUrl);
    await expect(page.locator('.agents-filter-bar')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#agents-date-preset')).toHaveValue('7d', { timeout: 5_000 });
    await expect(page.locator('.agent-tile').filter({ hasText: 'DF-6 old agent' })).not.toBeVisible({ timeout: 5_000 });
  });

});
