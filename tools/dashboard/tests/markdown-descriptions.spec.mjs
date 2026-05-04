/**
 * Markdown Description Rendering Tests
 *
 * Contract tests verifying that work item and epic descriptions render
 * markdown via renderMd() instead of plain text, with XSS sanitization
 * via DOMPurify.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, seedEpic, api } from './helpers.mjs';

const _MD_PROJECT_KEY = 'ticari/architect/main';
const _MD_PORTFOLIO_ENTRY = { worktree_mode: 'auto', worktree_setup: { branch: 'main' } };

test.describe('Markdown description rendering @behavioral', () => {

  test.beforeAll(async () => {
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: _MD_PROJECT_KEY, entry: _MD_PORTFOLIO_ENTRY }),
    });
  });


  test('MD-1: work item description renders markdown in project board detail row', async ({ page }) => {
    await seedWorkItem({
      title: 'MD-1 item',
      description: '**bold text** and a [link](http://example.com)',
      project_key: 'ticari/architect/main',
    });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('MD-1 item')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('tr[data-wi-row]', { has: page.getByText('MD-1 item') });
    const idx = await row.getAttribute('data-wi-row');
    const detailRow = page.locator(`tr.wi-detail[data-wi-detail="${idx}"]`);

    await row.locator('td:nth-child(2)').click();
    await expect(detailRow).toBeVisible({ timeout: 5_000 });

    const mdContainer = detailRow.locator('.md-inline');
    await expect(mdContainer).toBeVisible();
    await expect(mdContainer).toContainText('bold text');
    await expect(mdContainer).toContainText('link');
  });

  test('MD-2: work item description renders markdown in dispatch modal', async ({ page }) => {
    await seedWorkItem({
      title: 'MD-2 item',
      description: '# Heading\n\n- list item one',
      project_key: 'ticari/architect/main',
      status: 'planned',
    });
    await page.goto('/#component/ticari/architect/main');
    await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15_000 });
    await page.click('.dispatch-btn[data-wi-idx]');

    const modal = page.locator('.modal-overlay');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    const mdContainer = modal.locator('.md-inline');
    await expect(mdContainer).toBeVisible();
    await expect(mdContainer).toContainText('Heading');
    await expect(mdContainer).toContainText('list item one');
  });

  test('MD-3: epic description renders markdown in epic detail panel', async ({ page }) => {
    const epic = await seedEpic({
      title: 'MD-3 epic',
      description: '**epic bold** and `code snippet`',
    });
    await page.goto(`/#epic/${epic.id}`);
    await expect(page.getByRole('heading', { name: /MD-3 epic/ })).toBeVisible({ timeout: 15_000 });

    // Description is in the "Details" tab (tab index 3)
    await page.locator('.tab[data-tab="3"]').click();
    await expect(page.locator('.tab-content[data-panel="3"]')).toBeVisible({ timeout: 5_000 });

    const descSection = page.locator('.tab-content[data-panel="3"] .md-inline').first();
    await expect(descSection).toBeVisible();
    await expect(descSection).toContainText('epic bold');
    await expect(descSection).toContainText('code snippet');
  });

  test('MD-4: work item description renders markdown in epic linked tasks detail', async ({ page }) => {
    const epic = await seedEpic({ title: 'MD-4 epic' });
    const item = await seedWorkItem({
      title: 'MD-4 linked item',
      description: '**linked bold** description',
      project_key: 'ticari/architect/main',
    });
    await api(`epics/${epic.id}/link`, {
      method: 'POST',
      body: JSON.stringify({ work_item_ids: [item.id] }),
    });
    await expect(async () => {
      const epicData = await api(`epics/${epic.id}`);
      expect(epicData.work_item_ids || []).toContain(item.id);
    }).toPass({ timeout: 5_000, intervals: [100, 250, 500, 1000] });

    await page.goto(`/#epic/${epic.id}`);
    // Tasks tab (tab 0) is active by default
    await expect(page.getByText('MD-4 linked item')).toBeVisible({ timeout: 15_000 });

    // Click the "details" expand button for this work item
    await page.locator(`button[data-epic-wi-expand="${item.id}"]`).click();

    const detailRow = page.locator(`tr.wi-detail[data-epic-wi-detail="${item.id}"]`);
    await expect(detailRow).toBeVisible({ timeout: 5_000 });

    const mdContainer = detailRow.locator('.md-inline');
    await expect(mdContainer).toBeVisible();
    await expect(mdContainer).toContainText('linked bold');
  });

  test('MD-5: empty description does not render md-inline container', async ({ page }) => {
    await seedWorkItem({
      title: 'MD-5 empty desc',
      description: '',
      project_key: 'ticari/architect/main',
    });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('MD-5 empty desc')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('tr[data-wi-row]', { has: page.getByText('MD-5 empty desc') });
    const idx = await row.getAttribute('data-wi-row');
    const detailRow = page.locator(`tr.wi-detail[data-wi-detail="${idx}"]`);

    await row.locator('td:nth-child(2)').click();
    await expect(detailRow).toBeVisible({ timeout: 5_000 });
    await expect(detailRow.locator('.md-inline')).not.toBeVisible();
  });

  test('MD-6: XSS payload is sanitized in rendered description', async ({ page }) => {
    await seedWorkItem({
      title: 'MD-6 xss test',
      description: '<img src=x onerror=alert(1)> safe text',
      project_key: 'ticari/architect/main',
    });
    await page.goto('/#component/ticari/architect/main');
    await expect(page.getByText('MD-6 xss test')).toBeVisible({ timeout: 15_000 });

    const row = page.locator('tr[data-wi-row]', { has: page.getByText('MD-6 xss test') });
    const idx = await row.getAttribute('data-wi-row');
    const detailRow = page.locator(`tr.wi-detail[data-wi-detail="${idx}"]`);

    await row.locator('td:nth-child(2)').click();
    await expect(detailRow).toBeVisible({ timeout: 5_000 });

    const mdContainer = detailRow.locator('.md-inline');
    await expect(mdContainer).toBeVisible();
    await expect(mdContainer).toContainText('safe text');

    const html = await mdContainer.innerHTML();
    expect(html).not.toContain('onerror');
    expect(html).not.toMatch(/<script/i);
  });

});
