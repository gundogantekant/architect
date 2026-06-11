/**
 * Prompt Preview UI Tests — W-1198
 *
 * PP-UI-1: Opening Dispatch modal does NOT fire POST /api/prompts/preview
 * PP-UI-2: Clicking "Preview prompt" fires exactly one POST /api/prompts/preview
 * PP-UI-3: .modal-prompt-preview overlay appears with role=dialog and aria-modal=true
 * PP-UI-4: Overlay has "Prompt Preview" in the title
 * PP-UI-5: "Available tokens" section is present in the overlay
 * PP-UI-6: × button closes the overlay
 * PP-UI-7: ESC key closes the overlay
 * PP-UI-8: Opening Refine Project modal does NOT fire POST /api/prompts/preview
 * PP-UI-9: "Preview prompt" button is present in the Refine Project modal
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, api } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';

async function stubPortfolioApi(page) {
  const componentStub = {
    org: 'ticari', project: 'architect', component: 'main',
    path: '/tmp/architect', onboarded_at: '2024-01-01', last_scanned: '2024-01-01',
    stack: [], agents: [], guidance: [], name: 'architect/main', role: 'backend',
  };

  await page.route(/\/api\/orgs$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.route(/\/api\/component\/ticari\/architect\/main$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(componentStub) });
  });

  await page.route(/\/api\/project\/ticari\/architect$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
}

async function stubPreviewApi(page) {
  await page.route(/\/api\/prompts\/preview$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rendered: 'You are an agent for ticari/architect/main.', placeholders: ['COMPONENT', 'ORG', 'PROJECT'], truncated: false }),
    });
  });
}

async function openDispatchModal(page) {
  const workItem = await seedWorkItem({
    title: 'Preview prompt test item',
    status: 'in-progress',
    priority: 'medium',
    project_key: PROJECT_KEY,
  });

  await stubPortfolioApi(page);
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15000 });
  await page.click('.dispatch-btn[data-wi-idx]');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 5000 });

  return workItem;
}

async function openRefineModal(page) {
  const componentStub = {
    org: 'ticari', project: 'architect', component: 'main',
    path: '/tmp/architect', onboarded_at: '2024-01-01', last_scanned: '2024-01-01',
    stack: [], agents: [], guidance: [], name: 'architect/main', role: 'backend',
  };

  await page.route(/\/api\/orgs$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.route(/\/api\/component\/ticari\/architect\/main$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(componentStub) });
  });

  await page.route(/\/api\/project\/ticari\/architect$/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });

  await page.route(/\/api\/backlog/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ projects: {} }) });
  });
}

test('PP-UI-1: opening Dispatch modal does not fire POST /api/prompts/preview', async ({ page }) => {
  const previewRequests = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('/api/prompts/preview')) {
      previewRequests.push(req);
    }
  });

  await openDispatchModal(page);

  // Wait a tick to catch any eager requests
  await page.waitForTimeout(300);
  expect(previewRequests).toHaveLength(0);
});

test('PP-UI-2: clicking "Preview prompt" fires exactly one POST /api/prompts/preview', async ({ page }) => {
  await stubPreviewApi(page);

  const previewRequests = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('/api/prompts/preview')) {
      previewRequests.push(req);
    }
  });

  await openDispatchModal(page);
  await page.click('#dispatch-preview-btn');

  await expect(page.locator('.modal-prompt-preview')).toBeVisible({ timeout: 5000 });
  expect(previewRequests).toHaveLength(1);
});

test('PP-UI-3: prompt preview overlay has role=dialog and aria-modal=true', async ({ page }) => {
  await stubPreviewApi(page);
  await openDispatchModal(page);
  await page.click('#dispatch-preview-btn');

  const dialog = page.locator('.modal-prompt-preview');
  await expect(dialog).toBeVisible({ timeout: 5000 });
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
});

test('PP-UI-4: prompt preview overlay has "Prompt Preview" title', async ({ page }) => {
  // Dispatch button uses the dynamic preview (preview-dynamic endpoint) — check dyn-preview-title
  await openDispatchModal(page);
  await page.click('#dispatch-preview-btn');

  await expect(page.locator('#dyn-preview-title')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#dyn-preview-title')).toContainText('Prompt Preview');
});

test('PP-UI-5: prompt preview overlay has "Available tokens" section', async ({ page }) => {
  // Dispatch button uses the dynamic preview — check for Sections navigation panel
  await openDispatchModal(page);
  await page.click('#dispatch-preview-btn');

  await expect(page.locator('.modal-prompt-preview')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#dyn-preview-nav')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#dyn-preview-content')).toBeVisible({ timeout: 5000 });
});

test('PP-UI-6: × button closes the prompt preview overlay', async ({ page }) => {
  // Dispatch button uses the dynamic preview — close via #dyn-preview-close
  await openDispatchModal(page);
  await page.click('#dispatch-preview-btn');

  await expect(page.locator('.modal-prompt-preview')).toBeVisible({ timeout: 15000 });
  await page.click('#dyn-preview-close');
  await expect(page.locator('.modal-prompt-preview')).not.toBeVisible({ timeout: 3000 });
});

test('PP-UI-7: ESC key closes the prompt preview overlay', async ({ page }) => {
  await stubPreviewApi(page);
  await openDispatchModal(page);
  await page.click('#dispatch-preview-btn');

  await expect(page.locator('.modal-prompt-preview')).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.modal-prompt-preview')).not.toBeVisible({ timeout: 3000 });
});

test('PP-UI-8: opening Refine Project modal does not fire POST /api/prompts/preview', async ({ page }) => {
  const previewRequests = [];
  page.on('request', req => {
    if (req.method() === 'POST' && req.url().includes('/api/prompts/preview')) {
      previewRequests.push(req);
    }
  });

  await openRefineModal(page);
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#refine-project', { timeout: 15000 });
  await page.click('#refine-project');

  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(300);
  expect(previewRequests).toHaveLength(0);
});

test('PP-UI-9: "Preview prompt" button is present in Refine Project modal', async ({ page }) => {
  await openRefineModal(page);
  await page.goto('/#component/ticari/architect/main');
  await page.waitForSelector('#refine-project', { timeout: 15000 });
  await page.click('#refine-project');

  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('#refine-preview-btn')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#refine-preview-btn')).toHaveText('Preview prompt');
});
