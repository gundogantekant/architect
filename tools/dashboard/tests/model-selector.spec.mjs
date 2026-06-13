import { test, expect } from './fixtures.mjs';
import { seedWorkItem } from './helpers.mjs';

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

async function openDispatchModal(page) {
  const workItem = await seedWorkItem({
    title: 'Model selector test item',
    status: 'open',
    priority: 'medium',
    project_key: PROJECT_KEY,
  });

  await stubPortfolioApi(page);
  await page.goto(`/#component/ticari/architect/main`);
  await page.waitForSelector('.dispatch-btn[data-wi-idx]', { timeout: 15_000 });
  await page.click('.dispatch-btn[data-wi-idx]');
  await expect(page.locator('.modal-overlay')).toBeVisible({ timeout: 5_000 });

  return workItem;
}

test.describe('Model selector @fast', () => {
  test('MS-1: dispatch modal shows #dispatch-model select with sonnet selected by default', async ({ page }) => {
    await openDispatchModal(page);

    const modelSelect = page.locator('#dispatch-model');
    await expect(modelSelect).toBeVisible();
    await expect(modelSelect).toHaveValue('sonnet');
  });

  test('MS-2: selecting opus sends model:opus in POST body', async ({ page }) => {
    let capturedBody = null;

    await page.route(/\/api\/terminal$/, async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData());
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ terminal_id: 'T-ms2-stub', status: 'running' }),
        });
      } else {
        await route.continue();
      }
    });

    await openDispatchModal(page);
    await page.locator('#dispatch-model').selectOption('opus');
    await page.click('[data-modal-submit]');

    await expect(page.locator('.modal-overlay')).not.toBeVisible({ timeout: 8_000 });
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.model).toBe('opus');
  });

  test('MS-3: switching agent type to shell hides #dispatch-model', async ({ page }) => {
    await openDispatchModal(page);

    const modelField = page.locator('#dispatch-model').locator('xpath=ancestor::div[contains(@class,"field")]');
    await expect(modelField).toBeVisible();

    await page.locator('#dispatch-agent-type').selectOption('shell');

    await expect(modelField).not.toBeVisible();
  });
});
