/**
 * Theme System Contract Tests (TH-1 to TH-10)
 *
 * These tests define the behavioral contract for OS-aware terminal/log theming.
 * Uses Playwright's page.emulateMedia({ colorScheme }) to simulate OS theme.
 *
 * Test server started automatically by globalSetup on an isolated port.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch, seedTerminal } from './helpers.mjs';

// ============================================================
// Suite: Theme System (TH-1 to TH-10)
// ============================================================

test('TH-1: default preference is "system" when no explicit save', async ({ page }) => {
  await page.goto('/#settings');
  const dropdown = page.locator('#settings-terminal-theme');
  await expect(dropdown).toBeVisible({ timeout: 5000 });
  await expect(dropdown).toHaveValue('system');
});

test('TH-2: system theme + light OS → dispatch log gets log-light class', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['test output'] });
  await page.goto('/');
  const log = page.locator(`#log-${id}`);
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(log).toHaveClass(/log-light/);
});

test('TH-3: system theme + dark OS → dispatch log has no log-light class', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['test output'] });
  await page.goto('/');
  const log = page.locator(`#log-${id}`);
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(log).not.toHaveClass(/log-light/);
});

test('TH-4: explicit "dark" pref overrides light OS', async ({ page }) => {
  await fetch(`${getBase()}/api/settings/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal_theme: 'dark' }),
  });
  await page.emulateMedia({ colorScheme: 'light' });
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['test output'] });
  await page.goto('/');
  const log = page.locator(`#log-${id}`);
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(log).not.toHaveClass(/log-light/);
});

test('TH-5: explicit "light" pref overrides dark OS', async ({ page }) => {
  await fetch(`${getBase()}/api/settings/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal_theme: 'light' }),
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['test output'] });
  await page.goto('/');
  const log = page.locator(`#log-${id}`);
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(log).toHaveClass(/log-light/);
});

test('TH-6: real-time OS theme change updates open dispatch panels', async ({ page }) => {
  // Reset to system default (prior tests may have set an explicit pref)
  await fetch(`${getBase()}/api/settings/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal_theme: 'system' }),
  });
  await page.emulateMedia({ colorScheme: 'light' });
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['test output'] });
  await page.goto('/');
  const log = page.locator(`#log-${id}`);
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(log).toHaveClass(/log-light/);

  // Switch OS to dark — panels should update without reload
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(log).not.toHaveClass(/log-light/, { timeout: 5000 });
});

test('TH-7: real-time OS change ignored when explicit pref is set', async ({ page }) => {
  await fetch(`${getBase()}/api/settings/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminal_theme: 'light' }),
  });
  await page.emulateMedia({ colorScheme: 'light' });
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['test output'] });
  await page.goto('/');
  const log = page.locator(`#log-${id}`);
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(log).toHaveClass(/log-light/);

  // Switch OS to dark — explicit "light" pref should win
  await page.emulateMedia({ colorScheme: 'dark' });
  // Wait a bit to ensure the listener had time to fire (it should be a no-op)
  await page.waitForTimeout(500);
  await expect(log).toHaveClass(/log-light/);
});

test('TH-8: settings dropdown change applies theme immediately', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['test output'] });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Navigate to settings and change theme to "light"
  await page.goto('/#settings');
  const dropdown = page.locator('#settings-terminal-theme');
  await expect(dropdown).toBeVisible({ timeout: 5000 });
  await dropdown.selectOption('light');

  // Navigate back and check dispatch log
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#log-${id}`)).toHaveClass(/log-light/);
});

test('TH-9: settings log box follows theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/#settings');
  const logBox = page.locator('.settings-log-box');
  await expect(logBox).toBeVisible({ timeout: 5000 });
  await expect(logBox).toHaveClass(/log-light/);
});

test('TH-10: terminal container follows theme', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  const t = await seedTerminal();
  await page.goto('/');
  const container = page.locator(`#term-container-${t.id}`);
  await expect(page.locator(`#terminal-${t.id}`)).toBeVisible({ timeout: 5000 });
  await expect(container).toHaveClass(/terminal-light/);
});
