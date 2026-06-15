import { test, expect } from './fixtures.mjs';
import { seedTerminal, api } from './helpers.mjs';

test.describe('Terminal sidebar label @fast', () => {

  test('TSL-1: sidebar shows the note when a terminal has one', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true, status: 'running' });
    await api(`terminal/${t.id}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'my custom label' }),
    });

    await page.goto('/');
    const entry = page.locator(`#dispatches-list .session-entry`).filter({ hasText: 'my custom label' });
    await expect(entry.locator('.session-label')).toHaveText('my custom label', { timeout: 10_000 });
  });

  test('TSL-2: sidebar falls back to the title when there is no note', async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true, status: 'running' });
    const expectedTitle = `Test terminal ${t.id}`;

    await page.goto('/');
    const entry = page.locator(`#dispatches-list .session-entry`).filter({ hasText: expectedTitle });
    await expect(entry.locator('.session-label')).toHaveText(expectedTitle, { timeout: 10_000 });
  });

});
