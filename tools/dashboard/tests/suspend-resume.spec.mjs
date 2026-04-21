/**
 * Suspend/Resume E2E Test Suite (W-938)
 *
 * SR-1 to SR-8: Headless API contract tests (no real Claude spawn)
 * SR-9 to SR-11: Playwright UI state machine tests
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch } from './helpers.mjs';

test('SR-1: buildResumePrompt includes work item title and status', async ({ request }) => {
  const resp = await request.post(`${getBase()}/api/test/build-resume-prompt`, {
    data: { workItem: { id: 'W-938', title: 'Test item', status: 'in_progress', session_log: [] } },
  });
  const { prompt } = await resp.json();
  expect(prompt).toContain('W-938');
  expect(prompt).toContain('Test item');
  expect(prompt).toContain('in_progress');
});

test('SR-2: buildResumePrompt includes last 5 session log entries (capped)', async ({ request }) => {
  const log = Array.from({ length: 8 }, (_, i) => ({ summary: `entry-${i}`, timestamp: '2026-01-01T00:00:00Z' }));
  const resp = await request.post(`${getBase()}/api/test/build-resume-prompt`, {
    data: { workItem: { id: 'W-938', title: 'T', status: 'draft', session_log: log } },
  });
  const { prompt } = await resp.json();
  expect(prompt).toContain('entry-7');
  expect(prompt).toContain('entry-3');
  expect(prompt).not.toContain('entry-0');
  expect(prompt).not.toContain('entry-2');
});

test('SR-3: buildResumePrompt includes contract scope_boundary and stop_conditions when present', async ({ request }) => {
  const resp = await request.post(`${getBase()}/api/test/build-resume-prompt`, {
    data: {
      workItem: { id: 'W-1', title: 'T', status: 'draft', session_log: [] },
      contract: { scope_boundary: ['src/only'], stop_conditions: ['If error count > 5'] },
    },
  });
  const { prompt } = await resp.json();
  expect(prompt).toContain('src/only');
  expect(prompt).toContain('If error count > 5');
});

test('SR-4: buildResumePrompt omits contract section when contract is absent', async ({ request }) => {
  const resp = await request.post(`${getBase()}/api/test/build-resume-prompt`, {
    data: { workItem: { id: 'W-1', title: 'T', status: 'draft', session_log: [] }, contract: null },
  });
  const { prompt } = await resp.json();
  expect(prompt).not.toContain('Contract reminders');
});

test('SR-5: buildResumePrompt falls back to default instructions when none provided', async ({ request }) => {
  const resp = await request.post(`${getBase()}/api/test/build-resume-prompt`, {
    data: { workItem: { id: 'W-1', title: 'T', status: 'draft', session_log: [] } },
  });
  const { prompt } = await resp.json();
  expect(prompt).toContain('Continue where you left off.');
});

test('SR-6: POST /api/dispatch/:id/resume returns 400 for non-suspended dispatch', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'completed', claude_session_id: 'fake-id' });
  const resp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/resume`, { method: 'POST' });
  expect(resp.status).toBe(400);
});

test('SR-7: POST /api/dispatch/:id/resume returns 400 when no claude_session_id', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'suspended', claude_session_id: null });
  const resp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/resume`, { method: 'POST' });
  expect(resp.status).toBe(400);
});

test('SR-8: resume-args-preview returns agent info for known project', async () => {
  const resp = await fetch(`${getBase()}/api/test/resume-args-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ work_item_id: null, project_key: 'ticari/architect/main' }),
  });
  expect(resp.status).toBe(200);
  const result = await resp.json();
  expect(result).toHaveProperty('has_agents');
  expect(result).toHaveProperty('agent_count');
  expect(typeof result.agent_count).toBe('number');
});

test('SR-9: after resume click, old suspended panel disappears', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-session-sr9' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await page.locator(`[data-resume-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).not.toBeVisible({ timeout: 10000 });
});

test('SR-10: after resume click, a new dispatch panel with a different ID appears', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-session-sr10' });
  await page.goto('/');
  await expect(page.locator(`[data-resume-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });
  await page.locator(`[data-resume-dispatch="${id}"]`).click();
  // Wait for a dispatch panel that is NOT the old suspended panel
  await page.waitForFunction((oldId) => {
    const panels = document.querySelectorAll('[id^="dispatch-D-"]');
    return Array.from(panels).some(p => p.id !== `dispatch-${oldId}`);
  }, id, { timeout: 10000 });
});

test('SR-11: running dispatch panel shows suspend button, not resume button', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running', claude_session_id: 'fake-session-sr11' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-suspend-dispatch="${id}"]`)).toBeVisible();
  await expect(page.locator(`[data-resume-dispatch="${id}"]`)).not.toBeVisible();
});
