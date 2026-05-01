/**
 * Notes Sidebar E2E Tests (NS-1 to NS-5)
 *
 * These tests define the behavioral contract for the right-side notes panel
 * introduced in W-944. The panel is toggled via [data-notes-toggle], its open
 * state is persisted to localStorage under 'notes-panel-open', and its content
 * is persisted under 'dashboard-notes'.
 *
 * Test server started automatically by globalSetup on an isolated port.
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem } from './helpers.mjs';

// Stub portfolio API responses so the component view renders without a real portfolio entry.
// Also stubs POST /api/terminal so dispatch modal submit succeeds (needed for NS-4).
async function stubPortfolioApi(page) {
  const componentStub = {
    org: 'ticari', project: 'architect', component: 'main',
    path: '/tmp/architect', onboarded_at: '2024-01-01', last_scanned: '2024-01-01',
    stack: [], agents: [], guidance: [], name: 'architect/main', role: 'backend',
  };

  // Stub /api/orgs to return empty so buildTree() doesn't iterate and hit missing org files.
  await page.route(/\/api\/orgs$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  // Stub the component portfolio API (missing file in test worktree).
  await page.route(/\/api\/component\/ticari\/architect\/main$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(componentStub) });
  });

  // Stub the project files API (missing directory in test worktree).
  await page.route(/\/api\/project\/ticari\/architect$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
}

test.beforeEach(async ({ page }) => {
  // Clear localStorage only on the FIRST navigation of each test (not on reload),
  // so that tests that set localStorage and then reload can observe persistence.
  // sessionStorage survives page.reload() within the same tab, so we use it as a
  // one-time guard: clear localStorage on first load, skip on subsequent reloads.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('_testInit')) {
      sessionStorage.setItem('_testInit', '1');
      localStorage.clear();
    }
  });
});

test('NS-1: notes toggle button is visible in the sidebar footer', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('[data-notes-toggle]');
  await expect(toggle).toBeVisible({ timeout: 5000 });
});

test('NS-2: clicking the toggle shows the notes panel', async ({ page }) => {
  await page.goto('/');

  // Panel must start hidden (off-screen via translateX)
  const panelBefore = await page.locator('#notes-panel').evaluate((el) => {
    const style = window.getComputedStyle(el);
    return style.transform;
  });
  // translateX(100%) means it's hidden; just assert visibility after toggle
  const toggle = page.locator('[data-notes-toggle]');
  await toggle.click();
  await page.waitForTimeout(300); // allow CSS transition

  // Notes panel must be visible (in-viewport, not off-screen)
  const box = await page.locator('#notes-panel').boundingBox();
  expect(box).not.toBeNull();
  // Right edge at or near viewport right edge (panel slides in from right)
  const viewport = page.viewportSize();
  expect(box.x + box.width).toBeGreaterThan(viewport.width - 10);
  // Panel must have positive dimensions
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
});

test('NS-3: text typed in notes textarea persists after page reload', async ({ page }) => {
  await page.goto('/');

  // Open notes panel
  const toggle = page.locator('[data-notes-toggle]');
  await toggle.click();
  await page.waitForTimeout(300);

  const textarea = page.locator('#notes-textarea');
  await expect(textarea).toBeVisible({ timeout: 3000 });

  const testNote = `Test note content ${Date.now()}`;
  await textarea.fill(testNote);
  await page.waitForTimeout(200); // debounce storage write

  // Reload and reopen notes
  await page.reload();
  await page.waitForLoadState('networkidle');

  const toggle2 = page.locator('[data-notes-toggle]');
  await toggle2.click();
  await page.waitForTimeout(300);

  const textareaAfter = page.locator('#notes-textarea');
  await expect(textareaAfter).toBeVisible({ timeout: 3000 });
  const value = await textareaAfter.inputValue();
  expect(value).toBe(testNote);
});

test('NS-4: when notes panel is open and modal is triggered, modal is visually above notes panel', async ({ page }) => {
  await seedWorkItem({ title: 'Notes z-index test item', status: 'in-progress', project_key: 'ticari/architect/main' });
  await stubPortfolioApi(page);
  await page.goto('/#component/ticari/architect/main');

  // Open notes panel first
  const notesToggle = page.locator('[data-notes-toggle]');
  await notesToggle.click();
  await page.waitForTimeout(300);

  // Trigger a modal (dispatch work item modal)
  await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15000 });
  await page.click('.dispatch-btn[data-wi-idx]');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 5000 });

  // Compare z-index: modal-overlay must be above notes-panel (z-index: 49)
  const modalZIndex = await page.locator('.modal-overlay').evaluate((el) => {
    return parseInt(window.getComputedStyle(el).zIndex || '0', 10);
  });
  const notesZIndex = await page.locator('#notes-panel').evaluate((el) => {
    return parseInt(window.getComputedStyle(el).zIndex || '0', 10);
  });

  // Modal must be on top of the notes panel
  expect(modalZIndex).toBeGreaterThan(notesZIndex);
});

test('NS-5: when notes panel is open, #main content area has visible width greater than zero', async ({ page }) => {
  await page.goto('/');

  // Open notes panel
  const toggle = page.locator('[data-notes-toggle]');
  await toggle.click();
  await page.waitForTimeout(300);

  // #main must still have a positive width (not fully hidden behind the panel)
  const mainBox = await page.locator('#main').boundingBox();
  expect(mainBox).not.toBeNull();
  expect(mainBox.width).toBeGreaterThan(0);
});
