/**
 * Step 2 Gate: Modal Lifecycle Tests
 *
 * These tests define the behavioral contract for the createDispatchOverlay factory.
 * 3 tests per modal × 6 modals = 18 tests.
 *
 * MX-* tests: Context-aware field visibility based on agent type selection.
 *
 * Test server started automatically by globalSetup on an isolated port
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, seedEpic, api } from './helpers.mjs';

const _MODAL_PROJECT_KEY = 'ticari/architect/main';
const _MODAL_PROJECT_PATH = '/Users/tekantgundogan/Documents/architect';
const _MODAL_PORTFOLIO_ENTRY = { worktree_mode: 'auto', worktree_setup: { branch: 'main' } };

// beforeEach (not beforeAll) so registry entry is re-seeded after each purge-all.
// project_path is required so resolveProjectPath() can succeed when modals create terminals.
test.beforeEach(async () => {
  await api('test/seed-portfolio-entry', {
    method: 'POST',
    body: JSON.stringify({ project_key: _MODAL_PROJECT_KEY, project_path: _MODAL_PROJECT_PATH, entry: _MODAL_PORTFOLIO_ENTRY }),
  });
});

// ============================================================
// Modal 1: showDiscussModal
// Trigger: #discuss-agent button on #component/ticari/architect/main
// ============================================================

test('M-1-1: showDiscussModal opens on trigger click', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#discuss-agent', { timeout: 15000 });
  await page.click('#discuss-agent');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.modal-overlay h3')).toContainText('Discuss');
});

test('M-1-2: showDiscussModal cancel closes without creating session', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#discuss-agent', { timeout: 15000 });
  await page.click('#discuss-agent');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  const workerId = process.env.TEST_WORKER_INDEX;
  const beforeIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/terminal/active', { headers });
    return (await r.json()).map(t => t.id);
  }, workerId);

  await page.click('#discuss-cancel');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 3000 });

  const afterIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/terminal/active', { headers });
    return (await r.json()).map(t => t.id);
  }, workerId);
  const newIds = afterIds.filter(id => !beforeIds.includes(id));
  expect(newIds).toHaveLength(0);
});

test('M-1-3: showDiscussModal submit creates session and closes modal', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#discuss-agent', { timeout: 15000 });
  await page.click('#discuss-agent');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  await page.fill('#discuss-instructions', 'Test discussion prompt for modal lifecycle test');
  await page.click('#discuss-submit');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 8000 });
  await expect(page.locator('.terminal-panel, .dispatch-panel').first()).toBeVisible({ timeout: 8000 });
});

// ============================================================
// Modal 2: showReviewModal
// Trigger: #review-prs button on #component/ticari/architect/main
// ============================================================

test('M-2-1: showReviewModal opens on trigger click', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#review-prs', { timeout: 15000 });
  await page.click('#review-prs');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.modal-overlay h3')).toContainText('Review');
});

test('M-2-2: showReviewModal cancel closes without creating session', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#review-prs', { timeout: 15000 });
  await page.click('#review-prs');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  const workerId = process.env.TEST_WORKER_INDEX;
  const beforeIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/dispatch/active', { headers });
    return (await r.json()).map(d => d.id);
  }, workerId);

  await page.click('#review-cancel');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 3000 });

  const afterIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/dispatch/active', { headers });
    return (await r.json()).map(d => d.id);
  }, workerId);
  const newIds = afterIds.filter(id => !beforeIds.includes(id));
  expect(newIds).toHaveLength(0);
});

test('M-2-3: showReviewModal submit creates session and closes modal', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#review-prs', { timeout: 15000 });
  await page.click('#review-prs');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  // Wait for PR list to load, then provide instructions (no PRs expected in test env)
  await page.waitForTimeout(1000);
  await page.fill('#review-instructions', 'Review the codebase for general quality');
  await page.click('#review-submit');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 8000 });
  await expect(page.locator('.terminal-panel, .dispatch-panel').first()).toBeVisible({ timeout: 8000 });
});

// ============================================================
// Modal 3: dispatchWorkItem
// Trigger: .dispatch-btn[data-wi-idx] on #component/ticari/architect/main
// Requires: a seeded work item with status=open
// ============================================================

test('M-3-1: dispatchWorkItem modal opens on dispatch button click', async ({ page }) => {
  await seedWorkItem({ title: 'Modal lifecycle test item', status: 'in-progress' });
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15000 });
  await page.click('.dispatch-btn[data-wi-idx]');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.modal-overlay h3')).toContainText('Dispatch');
});

test('M-3-2: dispatchWorkItem cancel closes without creating session', async ({ page }) => {
  await seedWorkItem({ title: 'Modal lifecycle test item', status: 'in-progress' });
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15000 });
  await page.click('.dispatch-btn[data-wi-idx]');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  const workerId = process.env.TEST_WORKER_INDEX;
  const beforeIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/terminal/active', { headers });
    return (await r.json()).map(t => t.id);
  }, workerId);

  await page.click('#modal-cancel');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 3000 });

  const afterIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/terminal/active', { headers });
    return (await r.json()).map(t => t.id);
  }, workerId);
  const newIds = afterIds.filter(id => !beforeIds.includes(id));
  expect(newIds).toHaveLength(0);
});

test('M-3-3: dispatchWorkItem submit creates session and closes modal', async ({ page }) => {
  await seedWorkItem({ title: 'Modal lifecycle test item', status: 'in-progress' });
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15000 });
  await page.click('.dispatch-btn[data-wi-idx]');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  await page.click('#modal-dispatch');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 8000 });
  await expect(page.locator('.terminal-panel, .dispatch-panel').first()).toBeVisible({ timeout: 8000 });
});

// ============================================================
// Modal 4: showEpicDiscussModal
// Trigger: [data-epic-discuss] button on #epics list view
// Requires: a seeded epic
// ============================================================

test('M-4-1: showEpicDiscussModal opens on discuss button click', async ({ page }) => {
  const epic = await seedEpic({ title: 'Modal lifecycle epic' });
  const epicId = epic.id;
  await page.goto('/#epics');
  const trigger = page.locator(`[data-epic-discuss="${epicId}"]`);
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.modal-overlay h3')).toContainText('Discuss');
});

test('M-4-2: showEpicDiscussModal cancel closes without creating session', async ({ page }) => {
  const epic = await seedEpic({ title: 'Modal lifecycle epic' });
  const epicId = epic.id;
  await page.goto('/#epics');
  const trigger = page.locator(`[data-epic-discuss="${epicId}"]`);
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  await page.click('#epic-discuss-cancel');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 3000 });

  // No terminal should exist for this specific epic — other workers may create unrelated terminals
  const epicTerminals = await page.evaluate(async (id) => {
    const r = await fetch('/api/terminal/active');
    const data = await r.json();
    return data.filter(t => t.epic_id === id).length;
  }, epicId);
  expect(epicTerminals).toBe(0);
});

test('M-4-3: showEpicDiscussModal submit creates session and closes modal', async ({ page }) => {
  const epic = await seedEpic({ title: 'Modal lifecycle epic' });
  const epicId = epic.id;
  await page.goto('/#epics');
  const trigger = page.locator(`[data-epic-discuss="${epicId}"]`);
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  await page.fill('#epic-discuss-instructions', 'Discuss epic strategy for modal lifecycle test');
  await page.click('#epic-discuss-submit');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 8000 });
  await expect(page.locator('.terminal-panel, .dispatch-panel').first()).toBeVisible({ timeout: 8000 });
});

// ============================================================
// Modal 5: showEpicDispatchModal
// Trigger: [data-epic-dispatch] button on #epics list view
// Requires: a seeded epic
// ============================================================

test('M-5-1: showEpicDispatchModal opens on dispatch button click', async ({ page }) => {
  const epic = await seedEpic({ title: 'Modal lifecycle epic dispatch' });
  const epicId = epic.id;
  await page.goto('/#epics');
  const trigger = page.locator(`[data-epic-dispatch="${epicId}"]`);
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.modal-overlay h3')).toContainText('Dispatch');
});

test('M-5-2: showEpicDispatchModal cancel closes without creating session', async ({ page }) => {
  const epic = await seedEpic({ title: 'Modal lifecycle epic dispatch' });
  const epicId = epic.id;
  await page.goto('/#epics');
  const trigger = page.locator(`[data-epic-dispatch="${epicId}"]`);
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  const workerId = process.env.TEST_WORKER_INDEX;
  const beforeIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/dispatch/active', { headers });
    return (await r.json()).map(d => d.id);
  }, workerId);

  await page.click('#epic-dispatch-cancel');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 3000 });

  const afterIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const r = await fetch('/api/dispatch/active', { headers });
    return (await r.json()).map(d => d.id);
  }, workerId);
  const newIds = afterIds.filter(id => !beforeIds.includes(id));
  expect(newIds).toHaveLength(0);
});

test('M-5-3: showEpicDispatchModal submit creates session and closes modal', async ({ page }) => {
  const epic = await seedEpic({ title: 'Modal lifecycle epic dispatch' });
  const epicId = epic.id;
  // Dismiss any alert dialogs (e.g. "no project key" error)
  page.on('dialog', async dialog => { await dialog.dismiss(); });
  await page.goto('/#epics');
  const trigger = page.locator(`[data-epic-dispatch="${epicId}"]`);
  await expect(trigger).toBeVisible({ timeout: 15000 });
  await trigger.click();
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  // Wait for project dropdown to load registry keys before submitting
  await page.waitForFunction(() => {
    const sel = document.getElementById('epic-dispatch-project');
    return sel && sel.options.length > 0;
  }, { timeout: 15000 });

  // Provide instructions — backend requires work_item_id or additional_instructions
  await page.fill('#epic-dispatch-instructions', 'Work on this epic for modal lifecycle test');
  await page.click('#epic-dispatch-go');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 10000 });
  await expect(page.locator('.terminal-panel, .dispatch-panel').first()).toBeVisible({ timeout: 10000 });
});

// ============================================================
// Modal 6: showQuickDispatchModal
// Trigger: #agents-quick-dispatch button on #agents view
// ============================================================

test('M-6-1: showQuickDispatchModal opens on quick dispatch button click', async ({ page }) => {
  await page.goto('/#agents');
  await page.waitForSelector('#agents-quick-dispatch', { timeout: 15000 });
  await page.click('#agents-quick-dispatch');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('.modal-overlay h3')).toContainText('Quick Dispatch');
});

test('M-6-2: showQuickDispatchModal cancel closes without creating session', async ({ page }) => {
  await page.goto('/#agents');
  await page.waitForSelector('#agents-quick-dispatch', { timeout: 15000 });
  await page.click('#agents-quick-dispatch');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  const workerId = process.env.TEST_WORKER_INDEX;
  const beforeIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const [t, d] = await Promise.all([
      fetch('/api/terminal/active', { headers }).then(r => r.json()),
      fetch('/api/dispatch/active', { headers }).then(r => r.json()),
    ]);
    return [...t.map(s => `t:${s.id}`), ...d.map(s => `d:${s.id}`)];
  }, workerId);

  await page.click('#qd-cancel');
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 3000 });

  const afterIds = await page.evaluate(async (wid) => {
    const headers = wid !== undefined ? { 'x-test-worker-id': String(wid) } : {};
    const [t, d] = await Promise.all([
      fetch('/api/terminal/active', { headers }).then(r => r.json()),
      fetch('/api/dispatch/active', { headers }).then(r => r.json()),
    ]);
    return [...t.map(s => `t:${s.id}`), ...d.map(s => `d:${s.id}`)];
  }, workerId);
  const newIds = afterIds.filter(id => !beforeIds.includes(id));
  expect(newIds).toHaveLength(0);
});

test('M-6-3: showQuickDispatchModal submit creates session and closes modal', async ({ page }) => {
  await page.goto('/#agents');
  await page.waitForSelector('#agents-quick-dispatch', { timeout: 15000 });
  await page.click('#agents-quick-dispatch');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  await page.fill('#qd-instructions', 'Quick dispatch test for modal lifecycle');
  await page.click('#qd-go');

  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 8000 });
  await expect(page.locator('.terminal-panel, .dispatch-panel').first()).toBeVisible({ timeout: 8000 });
});

// ============================================================
// MX-*: Context-Aware Modal Field Visibility
// ============================================================

test('MX-1: Discuss modal hides permission fields when shell selected', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#discuss-agent', { timeout: 15000 });
  await page.click('#discuss-agent');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  // Initially (claude selected), permission fields should be visible
  await expect(page.locator('#discuss-perm-mode')).toBeVisible();

  // Switch to shell
  await page.selectOption('#discuss-agent-type', 'shell');
  await page.waitForTimeout(200);

  // Permission field parent (.field) should be hidden
  const permHidden = await page.evaluate(() => {
    const el = document.getElementById('discuss-perm-mode');
    const field = el?.closest('.field');
    return field ? field.style.display === 'none' : false;
  });
  expect(permHidden).toBe(true);
});

test('MX-2: Discuss modal shows permission fields when switching back to claude', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#discuss-agent', { timeout: 15000 });
  await page.click('#discuss-agent');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  // Switch to shell, then back to claude
  await page.selectOption('#discuss-agent-type', 'shell');
  await page.waitForTimeout(200);
  await page.selectOption('#discuss-agent-type', 'claude');
  await page.waitForTimeout(200);

  // Permission fields should be visible again
  await expect(page.locator('#discuss-perm-mode')).toBeVisible();
});

test('MX-3: Claude is default agent type with visible permission fields', async ({ page }) => {
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#discuss-agent', { timeout: 15000 });
  await page.click('#discuss-agent');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 3000 });

  const agentType = await page.locator('#discuss-agent-type').inputValue();
  expect(agentType).toBe('claude');
  await expect(page.locator('#discuss-perm-mode')).toBeVisible();
});
