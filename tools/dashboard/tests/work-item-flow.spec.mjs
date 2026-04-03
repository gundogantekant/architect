/**
 * Work Item Flow Tests
 *
 * Behavioral contract tests for work item lifecycle: creation, status updates,
 * dispatch linkage, deletion, and epic association.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, seedEpic, seedDispatch, api } from './helpers.mjs';

test.describe('Work item lifecycle @behavioral', () => {

  test('WF-1: work item appears in component view after creation', async ({ page }) => {
    await seedWorkItem({ title: 'Test task', status: 'open', project_key: 'ticari/architect/main' });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('Test task')).toBeVisible({ timeout: 15_000 });
  });

  test('WF-2: status update reflects after reload', async ({ page }) => {
    const item = await seedWorkItem({ title: 'Status test', status: 'open', project_key: 'ticari/architect/main' });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-progress' }) });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.locator('#wi-table').getByText('in-progress')).toBeVisible({ timeout: 15_000 });
  });

  test('WF-3: linked dispatch panel appears under work item', async ({ page }) => {
    await seedWorkItem({ title: 'Dispatch parent', status: 'open', project_key: 'ticari/architect/main' });
    const { dispatch_id } = await seedDispatch({ status: 'completed', work_item_id: undefined, output: ['Task done'] });
    await page.goto('/');
    // dispatch panel should appear in the global container
    await expect(page.locator(`#dispatch-${dispatch_id}`)).toBeVisible({ timeout: 15_000 });
  });

  test('WF-4: deleted work item disappears', async ({ page }) => {
    const item = await seedWorkItem({ title: 'To delete', status: 'open', project_key: 'ticari/architect/main' });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('To delete')).toBeVisible({ timeout: 10_000 });
    await api(`work-items/${item.id}`, { method: 'DELETE' });
    await page.reload();
    await expect(page.getByText('To delete')).not.toBeVisible({ timeout: 10_000 });
  });

  test('WF-5: epic view shows linked work item', async ({ page }) => {
    const epic = await seedEpic({ title: 'Test Epic' });
    const item = await seedWorkItem({ title: 'Epic child', status: 'open', project_key: 'ticari/architect/main' });
    // link item to epic (server expects work_item_ids array)
    await api(`epics/${epic.id}/link`, { method: 'POST', body: JSON.stringify({ work_item_ids: [item.id] }) });
    await page.goto(`/#epic/${epic.id}`);
    await expect(page.getByText('Epic child')).toBeVisible({ timeout: 15_000 });
  });

  test('WF-6: clicking work item row toggles details', async ({ page }) => {
    await seedWorkItem({ title: 'Row click toggle', status: 'open', project_key: 'ticari/architect/main' });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('Row click toggle')).toBeVisible({ timeout: 15_000 });

    // Find the row and its detail row
    const row = page.locator('tr[data-wi-row]', { has: page.getByText('Row click toggle') });
    const detailRow = row.locator('+ tr.wi-detail');

    // Detail row should be hidden initially
    await expect(detailRow).not.toBeVisible();

    // Click on the title cell (second column) to toggle details
    await row.locator('td:nth-child(2)').click();
    await expect(detailRow).toBeVisible({ timeout: 5000 });

    // The expand button text should change to 'hide'
    await expect(row.locator('.expand-btn')).toHaveText('hide');

    // Click again to collapse
    await row.locator('td:nth-child(2)').click();
    await expect(detailRow).not.toBeVisible();
    await expect(row.locator('.expand-btn')).toHaveText('details');
  });

  test('WF-7: clicking buttons on work item row does not toggle details', async ({ page }) => {
    await seedWorkItem({ title: 'Button guard test', status: 'open', project_key: 'ticari/architect/main' });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('Button guard test')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('tr[data-wi-row]', { has: page.getByText('Button guard test') });
    const detailRow = row.locator('+ tr.wi-detail');

    // Click the details button — this uses the existing handler, should toggle
    await row.locator('.expand-btn').click();
    await expect(detailRow).toBeVisible({ timeout: 5000 });

    // Close it back
    await row.locator('.expand-btn').click();
    await expect(detailRow).not.toBeVisible();

    // Click edit button — should NOT toggle details (should open edit modal instead)
    await row.locator('.edit-btn').click();
    await page.waitForTimeout(300);
    await expect(detailRow).not.toBeVisible();
  });
});
