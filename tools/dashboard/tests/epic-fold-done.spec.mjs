/**
 * Epic Auto-Fold E2E Tests
 *
 * EFD-1: all items done, no user pref → epic group auto-collapses
 * EFD-2: some items not done → epic group stays expanded
 * EFD-3: all done → user clicks to expand → group expands
 * EFD-4: all done, user expanded, page reload → stays expanded (pref persists)
 * EFD-5: epic with zero linked items → not rendered in board
 * EFD-6: userPref=false + all done → explicit expand wins over auto-fold
 * EFD-7: done items + cancelled items → cancelled excluded, epic auto-collapses
 * EFD-8: epic.status=done → auto-collapses regardless of item statuses
 */

import { test, expect } from './fixtures.mjs';
import { seedEpic, seedWorkItem, api } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';
const PORTFOLIO_ENTRY = { worktree_mode: 'explicit', worktree_setup: { branch: 'main' } };

test.beforeAll(async () => {
  await api('test/seed-portfolio-entry', {
    method: 'POST',
    body: JSON.stringify({ project_key: PROJECT_KEY, entry: PORTFOLIO_ENTRY }),
  });
});

async function resetCollapsePrefs(page) {
  await api('settings/preferences', {
    method: 'PUT',
    body: JSON.stringify({ board_epic_collapse: '{}' }),
  });
  // Reload so the page picks up the cleared prefs
  await page.reload();
}

async function navigateToBoard(page) {
  await page.goto(`/#component/ticari/architect/main`);
  // Wait for Board tab content to render
  await page.waitForFunction(() => document.querySelector('.tab-content.active') !== null, { timeout: 10000 });
}

test('EFD-1: all items done — epic group auto-collapses', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-1 epic' });
  const itemA = await seedWorkItem({ title: 'EFD-1 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });
  const itemB = await seedWorkItem({ title: 'EFD-1 B', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });

  // Ensure epic_id is linked on the items (work items seeded with epic_id should already be linked)
  // Also link via epics endpoint to be safe
  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [itemA.id, itemB.id] }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toBeVisible({ timeout: 10000 });
  await expect(group).toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).not.toBeVisible();
});

test('EFD-2: some items not done — epic group stays expanded', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-2 epic' });
  const itemA = await seedWorkItem({ title: 'EFD-2 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });
  const itemB = await seedWorkItem({ title: 'EFD-2 B', project_key: PROJECT_KEY, status: 'in-progress', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [itemA.id, itemB.id] }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toBeVisible({ timeout: 10000 });
  await expect(group).not.toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).toBeVisible();
});

test('EFD-3: all done → user clicks to expand → group expands', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-3 epic' });
  const item = await seedWorkItem({ title: 'EFD-3 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toHaveClass(/collapsed/, { timeout: 10000 });

  // Click header to expand
  await group.locator('.epic-group-header').click();

  await expect(group).not.toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).toBeVisible();
});

test('EFD-4: all done, user expanded, page reload — stays expanded', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-4 epic' });
  const item = await seedWorkItem({ title: 'EFD-4 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toHaveClass(/collapsed/, { timeout: 10000 });

  // User expands
  await group.locator('.epic-group-header').click();
  await expect(group).not.toHaveClass(/collapsed/);

  // Assert API stored false for this key
  const prefs = await api('settings/preferences');
  const collapseMap = JSON.parse(prefs.board_epic_collapse || '{}');
  expect(collapseMap[`${PROJECT_KEY}:${epic.id}`]).toBe(false);

  // Reload and assert still expanded
  await page.reload();
  const groupAfter = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(groupAfter).toBeVisible({ timeout: 10000 });
  await expect(groupAfter).not.toHaveClass(/collapsed/);
  await expect(groupAfter.locator('.epic-group-body')).toBeVisible();
});

test('EFD-5: epic with zero linked items — not rendered in board', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-5 empty epic' });

  await navigateToBoard(page);

  // Epic with no items is skipped by renderEpicGroupedBoard
  await expect(page.locator(`[data-epic-group="${epic.id}"]`)).not.toBeVisible({ timeout: 5000 });
});

test('EFD-6: userPref=false + all done — explicit expand wins over auto-fold', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-6 epic' });
  const item = await seedWorkItem({ title: 'EFD-6 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  // Pre-seed the pref as false (simulate user having previously expanded)
  const collapseMap = {};
  collapseMap[`${PROJECT_KEY}:${epic.id}`] = false;
  await api('settings/preferences', {
    method: 'PUT',
    body: JSON.stringify({ board_epic_collapse: JSON.stringify(collapseMap) }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toBeVisible({ timeout: 10000 });
  await expect(group).not.toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).toBeVisible();
});

test('EFD-7: done + cancelled items — cancelled excluded, epic auto-collapses', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-7 epic' });
  const itemA = await seedWorkItem({ title: 'EFD-7 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });
  const itemB = await seedWorkItem({ title: 'EFD-7 B', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });
  const itemC = await seedWorkItem({ title: 'EFD-7 C', project_key: PROJECT_KEY, status: 'cancelled', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [itemA.id, itemB.id, itemC.id] }),
  });

  await navigateToBoard(page);

  // 2 done + 1 cancelled = effectively complete; epic group must be collapsed
  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toBeVisible({ timeout: 10000 });
  await expect(group).toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).not.toBeVisible();
});

test('EFD-8: epic.status=done — auto-collapses regardless of item statuses', async ({ page }) => {
  // db.createEpic hardcodes 'draft' — patch to 'done' after creation
  const epic = await seedEpic({ title: 'EFD-8 epic' });
  await api(`epics/${epic.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  const item = await seedWorkItem({ title: 'EFD-8 A', project_key: PROJECT_KEY, status: 'in-progress', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toBeVisible({ timeout: 10000 });
  await expect(group).toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).not.toBeVisible();
});
