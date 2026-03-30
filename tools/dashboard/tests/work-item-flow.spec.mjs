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
});
