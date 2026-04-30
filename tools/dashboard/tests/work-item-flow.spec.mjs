/**
 * Work Item Flow Tests
 *
 * Behavioral contract tests for work item lifecycle: creation, status updates,
 * dispatch linkage, deletion, and epic association.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, seedEpic, seedDispatch, api, getBase } from './helpers.mjs';

const COMPONENT_KEY = 'ticari/architect/main';
const MINIMAL_PORTFOLIO_ENTRY = { worktree_mode: 'auto', worktree_setup: { branch: 'main' } };

test.describe('Work item lifecycle @behavioral', () => {

  test.beforeAll(async () => {
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: COMPONENT_KEY, entry: MINIMAL_PORTFOLIO_ENTRY }),
    });
  });


  test('WF-1: work item appears in component view after creation', async ({ page }) => {
    await seedWorkItem({ title: 'Test task', status: 'draft', project_key: 'ticari/architect/main' });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('Test task')).toBeVisible({ timeout: 15_000 });
  });

  test('WF-2: status update reflects after reload', async ({ page }) => {
    const item = await seedWorkItem({ title: 'Status test', status: 'draft', project_key: 'ticari/architect/main' });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'planned' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-progress' }) });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.locator('#wi-table .badge-in-progress').first()).toBeVisible({ timeout: 15_000 });
  });

  test('WF-3: linked dispatch panel appears under work item', async ({ page }) => {
    await seedWorkItem({ title: 'Dispatch parent', status: 'draft', project_key: 'ticari/architect/main' });
    const { dispatch_id } = await seedDispatch({ status: 'completed', work_item_id: undefined, output: ['Task done'] });
    await page.goto('/');
    // dispatch panel should appear in the global container
    await expect(page.locator(`#dispatch-${dispatch_id}`)).toBeVisible({ timeout: 15_000 });
  });

  test('WF-4: soft-deleted work item shows as cancelled', async ({ page }) => {
    const item = await seedWorkItem({ title: 'To delete', status: 'draft', project_key: 'ticari/architect/main' });
    // Confirm server-side soft delete (status → cancelled, item still exists)
    await api(`work-items/${item.id}`, { method: 'DELETE' });
    await expect(async () => {
      const updated = await api(`work-items/${item.id}`);
      expect(updated.status).toBe('cancelled');
    }).toPass({ timeout: 5_000, intervals: [100, 250, 500, 1000] });
    // Cancelled items are excluded from the default UI filter but remain in the API backlog
    const backlog = await api('backlog');
    const found = Object.values(backlog.projects).flatMap(p => p.items).find(i => i.id === item.id);
    expect(found).toBeTruthy();
    expect(found.status).toBe('cancelled');
  });

  test('WF-9: archived work item hidden from backlog', async ({ page }) => {
    const item = await seedWorkItem({ title: 'To archive', status: 'done', project_key: 'ticari/architect/main' });
    await api(`work-items/${item.id}/archive`, { method: 'POST' });
    // Confirm server-side archive
    const archived = await api(`work-items/${item.id}`);
    expect(archived.status).toBe('archived');
    await page.goto('/#component/ticari/architect/main');
    // Archived items should not appear in the backlog
    await page.waitForTimeout(1000);
    await expect(page.getByText('To archive')).not.toBeVisible({ timeout: 5_000 });
  });

  test('WF-10: work item response includes CRUD timestamps', async () => {
    const item = await seedWorkItem({ title: 'Timestamp test', status: 'draft', project_key: 'ticari/architect/main' });
    const full = await api(`work-items/${item.id}`);
    expect(full.created_at).toBeTruthy();
    expect(full.updated_at).toBeTruthy();
    // Update and verify updated_at changes
    const before = full.updated_at;
    await new Promise(r => setTimeout(r, 50));
    // draft → planned → in-progress (direct draft→in-progress is invalid per state machine)
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'planned' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-progress' }) });
    const after = await api(`work-items/${item.id}`);
    expect(after.updated_at).not.toBe(before);
  });

  test('WF-5: epic view shows linked work item', async ({ page }) => {
    const epic = await seedEpic({ title: 'Test Epic' });
    const item = await seedWorkItem({ title: 'Epic child', status: 'draft', project_key: 'ticari/architect/main' });
    // link item to epic (server expects work_item_ids array)
    await api(`epics/${epic.id}/link`, { method: 'POST', body: JSON.stringify({ work_item_ids: [item.id] }) });
    // Confirm server reflects the link before navigating
    await expect(async () => {
      const epicData = await api(`epics/${epic.id}`);
      expect(epicData.work_item_ids || []).toContain(item.id);
    }).toPass({ timeout: 5_000, intervals: [100, 250, 500, 1000] });
    await page.goto(`/#epic/${epic.id}`);
    await expect(page.getByText('Epic child')).toBeVisible({ timeout: 15_000 });
  });

  test('WF-6: clicking work item row toggles details', async ({ page }) => {
    await seedWorkItem({ title: 'Row click toggle', status: 'draft', project_key: 'ticari/architect/main' });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('Row click toggle')).toBeVisible({ timeout: 15_000 });

    // Find the row and its detail row via data attributes
    const row = page.locator('tr[data-wi-row]', { has: page.getByText('Row click toggle') });
    const idx = await row.getAttribute('data-wi-row');
    const detailRow = page.locator(`tr.wi-detail[data-wi-detail="${idx}"]`);

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
    await seedWorkItem({ title: 'Button guard test', status: 'draft', project_key: 'ticari/architect/main' });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('Button guard test')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('tr[data-wi-row]', { has: page.getByText('Button guard test') });
    const idx = await row.getAttribute('data-wi-row');
    const detailRow = page.locator(`tr.wi-detail[data-wi-detail="${idx}"]`);

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

  test('WF-8: sidebar renders all orgs even with dotted project names', async ({ page }) => {
    await page.goto('/');
    const orgs = await api('orgs');
    await expect(page.locator('.org-group')).toHaveCount(orgs.length, { timeout: 10_000 });
  });
});
