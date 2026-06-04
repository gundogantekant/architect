/**
 * Epic Link Lifecycle E2E Tests (W-1339)
 *
 * ELL-1: create epic → create two work items → link both to epic
 *        → navigate to epic view → assert both items appear
 *        → unlink one → assert epic view updates
 */

import { test, expect } from './fixtures.mjs';
import { seedEpic, seedWorkItem, api } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';
const MINIMAL_PORTFOLIO_ENTRY = { worktree_mode: 'explicit', worktree_setup: { branch: 'main' } };

test.describe('Epic Link Lifecycle @behavioral', () => {

  test.beforeAll(async () => {
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: PROJECT_KEY, entry: MINIMAL_PORTFOLIO_ENTRY }),
    });
  });

  test('ELL-1: link two items to epic, assert both visible, unlink one, assert epic view updates', async ({ page }) => {
    const epic = await seedEpic({ title: 'ELL-1 epic' });
    const itemA = await seedWorkItem({ title: 'ELL-1 item A', project_key: PROJECT_KEY });
    const itemB = await seedWorkItem({ title: 'ELL-1 item B', project_key: PROJECT_KEY });

    // Link both items to the epic
    await api(`epics/${epic.id}/link`, {
      method: 'POST',
      body: JSON.stringify({ work_item_ids: [itemA.id, itemB.id] }),
    });

    // Confirm server reflects both links before navigating
    await expect(async () => {
      const epicData = await api(`epics/${epic.id}`);
      const linked = epicData.work_item_ids || [];
      expect(linked).toContain(itemA.id);
      expect(linked).toContain(itemB.id);
    }).toPass({ timeout: 5_000, intervals: [100, 250, 500, 1000] });

    // Navigate to epic detail and assert both items are visible
    await page.goto(`/#epic/${epic.id}`);
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'ELL-1 item A' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'ELL-1 item B' })).toBeVisible({ timeout: 5_000 });

    // Unlink item B
    await api(`epics/${epic.id}/unlink`, {
      method: 'POST',
      body: JSON.stringify({ work_item_ids: [itemB.id] }),
    });

    // Confirm server reflects the unlink
    await expect(async () => {
      const epicData = await api(`epics/${epic.id}`);
      const linked = epicData.work_item_ids || [];
      expect(linked).not.toContain(itemB.id);
    }).toPass({ timeout: 5_000, intervals: [100, 250, 500, 1000] });

    // Reload epic view and assert item B is no longer listed
    await page.reload();
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'ELL-1 item A' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-ef-row]').filter({ hasText: 'ELL-1 item B' })).not.toBeVisible({ timeout: 5_000 });
  });

});
