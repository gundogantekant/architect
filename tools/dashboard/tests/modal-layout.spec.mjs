/**
 * Modal Layout E2E Tests (ML-1 to ML-4)
 *
 * These tests define the behavioral contract for the W-944 dispatch modal
 * layout changes. The dispatch work item modal now renders status and priority
 * as labeled fields inside a shared flex row ([data-field-group="status-priority"]).
 *
 * Uses page.route() to mock the portfolio API so the component view renders
 * work items without requiring a real portfolio entry on disk.
 *
 * ML-1: dispatch modal shows element with data-field="status"
 * ML-2: dispatch modal shows element with data-field="priority"
 * ML-3: status and priority elements share the same parent (data-field-group="status-priority")
 * ML-4: dispatching via the modal submit button creates a session
 *
 * Test server started automatically by globalSetup on an isolated port.
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';

// Stub portfolio API responses so the component view renders without a real portfolio entry.
async function stubPortfolioApi(page) {
  const componentStub = {
    org: 'ticari', project: 'architect', component: 'main',
    path: '/tmp/architect', onboarded_at: '2024-01-01', last_scanned: '2024-01-01',
    stack: [], agents: [], guidance: [], name: 'architect/main', role: 'backend',
  };

  // Stub /api/orgs to return empty so buildTree() doesn't iterate and hit missing org files.
  // This prevents the "Not Found" pageerror that blocks route() from running.
  await page.route(/\/api\/orgs$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // Stub the component portfolio API (missing file in test worktree).
  await page.route(/\/api\/component\/ticari\/architect\/main$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(componentStub),
    });
  });

  // Stub the project files API (missing directory in test worktree).
  await page.route(/\/api\/project\/ticari\/architect$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  // Stub POST /api/terminal and POST /api/terminal/shell so the dispatch onSubmit
  // handler succeeds and closes the modal. The fake terminal_id is used to build
  // the panel element in the DOM.
  await page.route(/\/api\/terminal(\/shell)?$/, (route) => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ terminal_id: 'T-ml4-stub', status: 'running' }),
      });
    } else {
      route.continue();
    }
  });
}

/**
 * Seed a work item, set up API stubs, navigate to the component view,
 * and click the dispatch button. Returns the work item.
 */
async function openDispatchModal(page) {
  const workItem = await seedWorkItem({
    title: 'Modal layout dispatch item',
    status: 'in-progress',
    priority: 'high',
    project_key: PROJECT_KEY,
  });

  await stubPortfolioApi(page);

  await page.goto(`/#component/ticari/architect/main`);
  await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15000 });
  await page.click('.dispatch-btn[data-wi-idx]');

  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 5000 });

  return workItem;
}

test('ML-1: dispatch modal has element with data-field="status" that is visible', async ({ page }) => {
  await openDispatchModal(page);

  const statusField = page.locator('[data-field="status"]');
  await expect(statusField).toBeVisible({ timeout: 3000 });
});

test('ML-2: dispatch modal has element with data-field="priority" that is visible', async ({ page }) => {
  await openDispatchModal(page);

  const priorityField = page.locator('[data-field="priority"]');
  await expect(priorityField).toBeVisible({ timeout: 3000 });
});

test('ML-3: status and priority elements share the same parent data-field-group="status-priority"', async ({ page }) => {
  await openDispatchModal(page);

  // Both fields must exist inside a single group container
  const groupLocator = page.locator('[data-field-group="status-priority"]');
  await expect(groupLocator).toBeVisible({ timeout: 3000 });

  // status and priority must be children of that group
  const statusInGroup = groupLocator.locator('[data-field="status"]');
  const priorityInGroup = groupLocator.locator('[data-field="priority"]');

  await expect(statusInGroup).toBeVisible({ timeout: 3000 });
  await expect(priorityInGroup).toBeVisible({ timeout: 3000 });
});

test('ML-4: dispatching via the modal submit button creates a session', async ({ page }) => {
  await openDispatchModal(page);

  // The architect project defaults to plan_execute (headless /api/dispatch). This test stubs
  // /api/terminal and exercises the interactive path, so explicitly select Accept edits.
  await page.locator('#dispatch-perm-mode').selectOption('acceptEdits');
  // Submit the dispatch
  await page.click('#modal-dispatch');

  // Modal must close
  await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 8000 });

  // A session panel must appear
  await expect(
    page.locator('.terminal-panel, .dispatch-panel').first(),
  ).toBeVisible({ timeout: 10000 });
});
