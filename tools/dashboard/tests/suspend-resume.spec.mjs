/**
 * Suspend/Resume E2E Test Suite (W-938)
 *
 * SR-1 to SR-8: Headless API contract tests (no real Claude spawn)
 * SR-9 to SR-11: Playwright UI state machine tests
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch, seedTerminal } from './helpers.mjs';

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

test('SR-9: after resume click, old suspended entry disappears from suspended panel', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-session-sr9' });
  await page.goto('/');
  await expect(page.locator(`[data-susp-resume-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });
  await page.locator(`[data-susp-resume-dispatch="${id}"]`).click();
  await expect(page.locator(`[data-susp-resume-dispatch="${id}"]`)).not.toBeVisible({ timeout: 10000 });
});

test('SR-10: after resume click, a new running dispatch panel appears', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-session-sr10' });
  await page.goto('/');
  await expect(page.locator(`[data-susp-resume-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });
  await page.locator(`[data-susp-resume-dispatch="${id}"]`).click();
  // Wait for a dispatch panel that is NOT the old suspended entry
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

test('SR-12: POST /api/terminal/:id/suspend on shell terminal returns 400', async ({ request }) => {
  const t = await seedTerminal({ status: 'running', agentType: 'shell' });
  const resp = await request.post(`${getBase()}/api/terminal/${t.id}/suspend`);
  expect(resp.status()).toBe(400);
  const body = await resp.json();
  expect(body.error).toContain('Claude sessions');
});

test('SR-13: POST /api/terminal/:id/suspend on Claude terminal with session ID returns 200', async ({ request }) => {
  const t = await seedTerminal({ status: 'running', agentType: 'claude', claude_session_id: 'fake-sr13' });
  const resp = await request.post(`${getBase()}/api/terminal/${t.id}/suspend`);
  expect(resp.status()).toBe(200);
  const body = await resp.json();
  expect(body.status).toBe('suspended');
});

test('SR-14: POST /api/terminal/:id/suspend on Claude terminal without session ID returns 400', async ({ request }) => {
  const t = await seedTerminal({ status: 'running', agentType: 'claude' });
  const resp = await request.post(`${getBase()}/api/terminal/${t.id}/suspend`);
  expect(resp.status()).toBe(400);
  const body = await resp.json();
  expect(body.error).toMatch(/session/i);
});

test('SR-15: POST /api/terminal/:id/resume with no claude_session_id returns 400', async ({ request }) => {
  const t = await seedTerminal({ status: 'suspended', agentType: 'claude' });
  const resp = await request.post(`${getBase()}/api/terminal/${t.id}/resume`);
  expect(resp.status()).toBe(400);
});

test('SR-16: GET /api/dispatch/active includes suspended dispatch after DB roundtrip', async ({ request }) => {
  const { dispatch_id } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-sr16' });
  const resp = await request.get(`${getBase()}/api/dispatch/active`);
  const list = await resp.json();
  const found = list.find(d => d.id === dispatch_id);
  expect(found).toBeDefined();
  expect(found.status).toBe('suspended');
});

test('SR-17: GET /api/terminal/suspended returns only suspended terminals', async ({ request }) => {
  const suspended = await seedTerminal({ status: 'suspended', agentType: 'claude', claude_session_id: 'fake-sr17' });
  const running = await seedTerminal({ status: 'running', agentType: 'claude' });
  const resp = await request.get(`${getBase()}/api/terminal/suspended`);
  expect(resp.status()).toBe(200);
  const list = await resp.json();
  expect(Array.isArray(list)).toBe(true);
  expect(list.find(t => t.id === suspended.id)).toBeDefined();
  expect(list.find(t => t.id === running.id)).toBeUndefined();
  expect(list.every(t => t.status === 'suspended')).toBe(true);
});

test('SR-18: GET /api/dispatch/suspended returns only suspended dispatches', async ({ request }) => {
  const { dispatch_id: suspendedId } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-sr18' });
  const { dispatch_id: runningId } = await seedDispatch({ status: 'running' });
  const resp = await request.get(`${getBase()}/api/dispatch/suspended`);
  expect(resp.status()).toBe(200);
  const list = await resp.json();
  expect(Array.isArray(list)).toBe(true);
  expect(list.find(d => d.id === suspendedId)).toBeDefined();
  expect(list.find(d => d.id === runningId)).toBeUndefined();
  expect(list.every(d => d.status === 'suspended')).toBe(true);
});

test('SR-19: GET /api/terminal/active still returns all statuses', async ({ request }) => {
  const suspended = await seedTerminal({ status: 'suspended', agentType: 'claude', claude_session_id: 'fake-sr19-s' });
  const running = await seedTerminal({ status: 'running', agentType: 'claude' });
  const resp = await request.get(`${getBase()}/api/terminal/active`);
  expect(resp.status()).toBe(200);
  const list = await resp.json();
  expect(list.find(t => t.id === suspended.id)).toBeDefined();
  expect(list.find(t => t.id === running.id)).toBeDefined();
});

test('SR-20: suspended dispatch panel exists in DOM after page load (not skipped)', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-sr20' });
  await page.goto('/');
  // Panel must be created and carry status-suspended class
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  const cls = await page.locator(`#dispatch-${id}`).getAttribute('class');
  expect(cls).toContain('status-suspended');
  // Resume button must be visible in the inline panel
  await expect(page.locator(`[data-resume-dispatch="${id}"]`)).toBeVisible();
});

test('SR-21: suspended terminal panel exists in DOM after page load (not skipped)', async ({ page }) => {
  const t = await seedTerminal({ status: 'suspended', agentType: 'claude', claude_session_id: 'fake-sr21' });
  await page.goto('/');
  // Panel must be created and carry status-suspended class
  await expect(page.locator(`#terminal-${t.id}`)).toBeVisible({ timeout: 5000 });
  const cls = await page.locator(`#terminal-${t.id}`).getAttribute('class');
  expect(cls).toContain('status-suspended');
  // Resume button must be visible in the inline panel
  await expect(page.locator(`[data-resume-terminal="${t.id}"]`)).toBeVisible();
});

test('SR-22: suspended terminal panel body shows placeholder text, not "Connecting"', async ({ page }) => {
  const t = await seedTerminal({ status: 'suspended', agentType: 'claude', claude_session_id: 'fake-sr22' });
  await page.goto('/');
  await expect(page.locator(`#terminal-${t.id}`)).toBeVisible({ timeout: 5000 });
  // _defaultExpanded fixture starts panels expanded — body is visible without interaction
  const bodyText = await page.locator(`#term-container-${t.id}`).textContent();
  expect(bodyText).toContain('Session suspended');
  expect(bodyText).not.toContain('Connecting');
});
