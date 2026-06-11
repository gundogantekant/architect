/**
 * Epic Visibility E2E Tests
 *
 * EFD-1: all items done, epic.status=active → epic stays visible and NOT auto-collapsed
 * EFD-2: some items not done → epic stays visible and expanded
 * EFD-3: user manually collapses active epic → group collapses
 * EFD-4: user collapse pref persists across page reload
 * EFD-5: epic with zero linked items → not rendered in board
 * EFD-6: userPref=true → epic stays collapsed (user pref respected)
 * EFD-7: done + cancelled items, status active → no auto-fold, epic stays visible
 * EFD-8: epic.status=done → hidden from board by default, toggle appears
 * EFD-9: board toggle reveals hidden done epic and hides it again
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

async function resetPrefs(page) {
  await api('settings/preferences', {
    method: 'PUT',
    body: JSON.stringify({ board_epic_collapse: '{}' }),
  });
  await page.evaluate(() => sessionStorage.removeItem('board-show-completed-epics'));
  await page.reload();
}

async function navigateToBoard(page) {
  await page.goto(`/#component/ticari/architect/main`);
  await page.waitForFunction(() => document.querySelector('.tab-content.active') !== null, { timeout: 10000 });
}

test('EFD-1: all items done with status active — epic stays visible and NOT auto-collapsed', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-1 epic' });
  const itemA = await seedWorkItem({ title: 'EFD-1 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });
  const itemB = await seedWorkItem({ title: 'EFD-1 B', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });

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

test('EFD-2: some items not done — epic stays visible and expanded', async ({ page }) => {
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

test('EFD-3: user manually collapses active epic — group collapses', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-3 epic' });
  const item = await seedWorkItem({ title: 'EFD-3 A', project_key: PROJECT_KEY, status: 'in-progress', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).not.toHaveClass(/collapsed/, { timeout: 10000 });

  await group.locator('.epic-group-header').click();

  await expect(group).toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).not.toBeVisible();
});

test('EFD-4: user collapse pref persists across page reload', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-4 epic' });
  const item = await seedWorkItem({ title: 'EFD-4 A', project_key: PROJECT_KEY, status: 'in-progress', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).not.toHaveClass(/collapsed/, { timeout: 10000 });

  // User collapses
  await group.locator('.epic-group-header').click();
  await expect(group).toHaveClass(/collapsed/);

  // Assert pref stored
  const prefs = await api('settings/preferences');
  const collapseMap = JSON.parse(prefs.board_epic_collapse || '{}');
  expect(collapseMap[`${PROJECT_KEY}:${epic.id}`]).toBe(true);

  // Reload and assert still collapsed
  await page.reload();
  const groupAfter = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(groupAfter).toBeVisible({ timeout: 10000 });
  await expect(groupAfter).toHaveClass(/collapsed/);
  await expect(groupAfter.locator('.epic-group-body')).not.toBeVisible();
});

test('EFD-5: epic with zero linked items — not rendered in board', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-5 empty epic' });

  await navigateToBoard(page);

  await expect(page.locator(`[data-epic-group="${epic.id}"]`)).not.toBeVisible({ timeout: 5000 });
});

test('EFD-6: userPref=true + active epic — stays collapsed', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-6 epic' });
  const item = await seedWorkItem({ title: 'EFD-6 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  // Pre-seed pref as true (simulate user having previously collapsed)
  const collapseMap = {};
  collapseMap[`${PROJECT_KEY}:${epic.id}`] = true;
  await api('settings/preferences', {
    method: 'PUT',
    body: JSON.stringify({ board_epic_collapse: JSON.stringify(collapseMap) }),
  });

  await navigateToBoard(page);

  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toBeVisible({ timeout: 10000 });
  await expect(group).toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).not.toBeVisible();

  // Cleanup
  await api('settings/preferences', {
    method: 'PUT',
    body: JSON.stringify({ board_epic_collapse: '{}' }),
  });
});

test('EFD-7: done + cancelled items, status active — no auto-fold, epic stays visible', async ({ page }) => {
  const epic = await seedEpic({ title: 'EFD-7 epic' });
  const itemA = await seedWorkItem({ title: 'EFD-7 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });
  const itemB = await seedWorkItem({ title: 'EFD-7 B', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });
  const itemC = await seedWorkItem({ title: 'EFD-7 C', project_key: PROJECT_KEY, status: 'cancelled', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [itemA.id, itemB.id, itemC.id] }),
  });

  await navigateToBoard(page);

  // Dynamic completion check removed — active epic with done+cancelled items is NOT hidden or auto-folded
  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).toBeVisible({ timeout: 10000 });
  await expect(group).not.toHaveClass(/collapsed/);
  await expect(group.locator('.epic-group-body')).toBeVisible();
});

test('EFD-8: epic.status=done — hidden from board, toggle appears', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.removeItem('board-show-completed-epics'));

  const epic = await seedEpic({ title: 'EFD-8 epic' });
  await api(`epics/${epic.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  const item = await seedWorkItem({ title: 'EFD-8 A', project_key: PROJECT_KEY, status: 'in-progress', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  await navigateToBoard(page);

  // Done epic is hidden — group element is not in DOM
  const group = page.locator(`[data-epic-group="${epic.id}"]`);
  await expect(group).not.toBeVisible({ timeout: 10000 });

  // Toggle appears because there are hidden epics
  await expect(page.locator('[data-board-completed-toggle]')).toBeVisible();
});

test('EFD-9: board toggle reveals hidden done epic, then hides it again', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.removeItem('board-show-completed-epics'));

  const epic = await seedEpic({ title: 'EFD-9 epic' });
  await api(`epics/${epic.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  const item = await seedWorkItem({ title: 'EFD-9 A', project_key: PROJECT_KEY, status: 'done', epic_id: epic.id });

  await api(`epics/${epic.id}/link`, {
    method: 'POST',
    body: JSON.stringify({ work_item_ids: [item.id] }),
  });

  await navigateToBoard(page);

  // Hidden by default
  await expect(page.locator(`[data-epic-group="${epic.id}"]`)).not.toBeVisible({ timeout: 10000 });

  // Click toggle to show
  await page.locator('[data-board-completed-toggle]').first().click();
  await expect(page.locator(`[data-epic-group="${epic.id}"]`)).toBeVisible({ timeout: 10000 });

  // Click toggle to hide again
  await page.locator('[data-board-completed-toggle]').first().click();
  await expect(page.locator(`[data-epic-group="${epic.id}"]`)).not.toBeVisible({ timeout: 10000 });
});
