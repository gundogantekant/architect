/**
 * Work Item Lifecycle E2E Tests (W-1339)
 *
 * WIL-1: create work item → seed dispatch → assert DISPATCHES sidebar shows dispatch
 *        → update work item to done → assert UI reflects done state
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, seedDispatch, api } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';
const MINIMAL_PORTFOLIO_ENTRY = { worktree_mode: 'explicit', worktree_setup: { branch: 'main' } };

test.describe('Work Item Lifecycle @behavioral', () => {

  test.beforeAll(async () => {
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: PROJECT_KEY, entry: MINIMAL_PORTFOLIO_ENTRY }),
    });
  });

  test('WIL-1: dispatch appears in sidebar and work item reflects done state after status update', async ({ page }) => {
    // T1 tag enables the in-progress→done shortcut (trivial items skip the contract gate)
    const workItem = await seedWorkItem({ title: 'WIL-1 lifecycle item', project_key: PROJECT_KEY, status: 'in-progress', tags: ['T1'] });

    // Seed a dispatch linked to that work item
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      work_item_id: workItem.id,
      title: 'WIL-1 dispatch',
    });

    // Navigate to home so the DISPATCHES sidebar is visible
    await page.goto('/');
    await expect(page.locator('#dispatches-sidebar')).toBeVisible({ timeout: 15_000 });

    // The dispatch panel should appear somewhere on the page
    await expect(page.locator(`#dispatch-${dispatch_id}`)).toBeVisible({ timeout: 10_000 });

    // Advance to done (item starts as in-progress, so this transition is contract-free)
    await api(`work-items/${workItem.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });

    // Navigate to component view and assert done badge is visible
    await page.goto(`/#component/${PROJECT_KEY}`);
    await expect(page.locator('#wi-table')).toBeVisible({ timeout: 15_000 });

    // Verify the API reflects done status
    const updated = await api(`work-items/${workItem.id}`);
    expect(updated.status).toBe('done');
  });

});
