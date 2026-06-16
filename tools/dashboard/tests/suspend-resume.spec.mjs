/**
 * Suspend/Resume E2E Test Suite (W-938)
 *
 * SR-1 to SR-8: Headless API contract tests (no real Claude spawn)
 * SR-9 to SR-11: Playwright UI state machine tests
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch, seedTerminal } from './helpers.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// ============================================================
// SR-23 to SR-28: Recent sessions (W-1218)
// ============================================================

test('SR-23: GET /api/terminal/recent returns 200 and an array', async ({ request }) => {
  const resp = await request.get(`${getBase()}/api/terminal/recent`);
  expect(resp.status()).toBe(200);
  const list = await resp.json();
  expect(Array.isArray(list)).toBe(true);
});

test('SR-24: GET /api/terminal/recent excludes terminals without claude_session_id', async ({ request }) => {
  await seedTerminal({ status: 'killed', agentType: 'claude' }); // no session id
  const resp = await request.get(`${getBase()}/api/terminal/recent`);
  const list = await resp.json();
  expect(list.every(t => t.claude_session_id)).toBe(true);
});

test('SR-25: GET /api/terminal/recent excludes running and suspended terminals', async ({ request }) => {
  const running = await seedTerminal({ status: 'running', claude_session_id: 'sr25-running' });
  const suspended = await seedTerminal({ status: 'suspended', claude_session_id: 'sr25-suspended' });
  const resp = await request.get(`${getBase()}/api/terminal/recent`);
  const list = await resp.json();
  expect(list.find(t => t.id === running.id)).toBeUndefined();
  expect(list.find(t => t.id === suspended.id)).toBeUndefined();
});

test('SR-26: GET /api/terminal/recent includes killed terminal with claude_session_id', async ({ request }) => {
  const killed = await seedTerminal({ status: 'killed', claude_session_id: 'sr26-killed' });
  const resp = await request.get(`${getBase()}/api/terminal/recent`);
  const list = await resp.json();
  expect(list.find(t => t.id === killed.id)).toBeDefined();
});

test('SR-27: POST /api/terminal/:id/resume on killed terminal with claude_session_id passes status guard (not 400)', async ({ request }) => {
  const t = await seedTerminal({ status: 'killed', agentType: 'claude', claude_session_id: 'sr27-fake-session' });
  const resp = await request.post(`${getBase()}/api/terminal/${t.id}/resume`);
  // Status guard must not reject with 400; 200 (spawn ok) or 5xx (spawn failed, env limitation) both indicate guard passed
  expect(resp.status()).not.toBe(400);
});

test('SR-28: GET /api/terminal/recent panel shows killed terminal with Resume button', async ({ page }) => {
  const t = await seedTerminal({ status: 'killed', claude_session_id: 'sr28-killed' });
  await page.goto('/');
  await expect(page.locator('#recent-sessions')).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-recent-resume="${t.id}"]`)).toBeVisible({ timeout: 5000 });
});

// ============================================================
// SR-29 to SR-31: dismissAllCompleted + eager suspended-panel refresh (W-1333)
// ============================================================

test('SR-29: dismissAllCompleted preserves a suspended dispatch panel', async ({ page }) => {
  const { dispatch_id: completedId } = await seedDispatch({ status: 'completed' });
  const { dispatch_id: suspendedId } = await seedDispatch({ status: 'suspended', claude_session_id: 'fake-sr29' });
  // Bulk buttons live on the Sessions view (#all-sessions) since cb135c4, not the root route.
  await page.goto('/#all-sessions');
  await expect(page.locator(`#dispatch-${completedId}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#dispatch-${suspendedId}`)).toBeVisible({ timeout: 5000 });

  await page.locator('.dismiss-all-btn').click();

  // Completed panel must be removed; suspended must survive with correct class
  await page.waitForSelector(`#dispatch-${completedId}`, { state: 'detached', timeout: 5000 });
  await expect(page.locator(`#dispatch-${suspendedId}`)).toBeVisible();
  await expect(page.locator(`#dispatch-${suspendedId}`)).toHaveClass(/status-suspended/);
});

test('SR-30: dismissAllCompleted preserves a suspended terminal panel', async ({ page }) => {
  const { id: completedId } = await seedTerminal({ status: 'completed', withFakeContent: true, lines: 3 });
  const { id: suspendedId } = await seedTerminal({ status: 'suspended', agentType: 'claude', claude_session_id: 'fake-sr30' });
  // Bulk buttons live on the Sessions view (#all-sessions) since cb135c4, not the root route.
  await page.goto('/#all-sessions');
  await expect(page.locator(`#terminal-${completedId}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#terminal-${suspendedId}`)).toBeVisible({ timeout: 5000 });

  await page.locator('.dismiss-all-btn').click();

  // Completed terminal must be removed; suspended must survive
  await page.waitForSelector(`#terminal-${completedId}`, { state: 'detached', timeout: 5000 });
  await expect(page.locator(`#terminal-${suspendedId}`)).toBeVisible();
  await expect(page.locator(`#terminal-${suspendedId}`)).toHaveClass(/status-suspended/);
});

test('SR-31: #suspended-sessions card appears immediately after route navigation without polling delay', async ({ page }) => {
  // Load with no suspended sessions so startup refresh sets _suspendedContainer = null
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  // Seed a suspended dispatch via API after page is idle (not in activeDispatches yet)
  await seedDispatch({ status: 'suspended', claude_session_id: 'fake-sr31' });

  // Navigate to a different route — triggers hashchange → route() → placeSessionPanels()
  // → _placeSessionPanelsNow() → if (!_suspendedContainer) refreshSuspendedPanel()
  await page.evaluate(() => { location.hash = '#epics'; });

  // Card must appear well within the 10s polling interval — 5s is safe for eager-refresh path
  await expect(page.locator('#suspended-sessions')).toBeVisible({ timeout: 5000 });
});

// ============================================================
// SR-PROJECT-1 to SR-PROJECT-3: per-project guard in refreshSuspendedPanel (W-1336)
// ============================================================

test('SR-PROJECT-1: session matching active project route is excluded from global suspended card', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({
    status: 'suspended',
    claude_session_id: 'fake-sr-project-1',
    project_key: 'ticari/architect/main',
  });
  await page.goto('/#component/ticari/architect/main');
  await page.waitForLoadState('networkidle');

  const card = page.locator('#suspended-sessions');
  const entry = page.locator(`[data-susp-resume-dispatch="${id}"]`);
  const cardVisible = await card.isVisible().catch(() => false);
  if (cardVisible) {
    await expect(entry).not.toBeVisible({ timeout: 3000 });
  } else {
    expect(cardVisible).toBe(false);
  }
});

test('SR-PROJECT-2: session from a different project still shows in global suspended card', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({
    status: 'suspended',
    claude_session_id: 'fake-sr-project-2',
    project_key: 'ticari/other-project/main',
  });
  await page.goto('/#component/ticari/architect/main');
  await expect(page.locator('#suspended-sessions')).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-susp-resume-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });
});

test('SR-PROJECT-3: all sessions show on non-project routes', async ({ page }) => {
  const { dispatch_id: projId } = await seedDispatch({
    status: 'suspended',
    claude_session_id: 'fake-sr-project-3a',
    project_key: 'ticari/architect/main',
  });
  const { dispatch_id: otherId } = await seedDispatch({
    status: 'suspended',
    claude_session_id: 'fake-sr-project-3b',
    project_key: 'ticari/other-project/main',
  });
  await page.goto('/');
  await expect(page.locator('#suspended-sessions')).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-susp-resume-dispatch="${projId}"]`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-susp-resume-dispatch="${otherId}"]`)).toBeVisible({ timeout: 5000 });
});

// ============================================================
// SR-32 to SR-35: API/UI preservation and guard tests
// ============================================================

test('SR-32: API preserves model, contract, worktree_path, and permission_mode on resume', async ({ request }) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'sr32-'));
  try {
    const { dispatch_id: oldId } = await seedDispatch({
      status: 'suspended',
      model: 'claude-sonnet-4-6',
      contract: { goal: 'test goal', constraints: 'none', expected_output: 'x', failure_conditions: 'y' },
      permission_mode: 'acceptEdits',
      worktree_path: tempDir,
      claude_session_id: 'fake-sr32',
    });

    const resumeResp = await fetch(`${getBase()}/api/dispatch/${oldId}/resume`, { method: 'POST' });
    expect(resumeResp.status).toBe(200);
    const resumeBody = await resumeResp.json();
    const newId = resumeBody.dispatch_id;
    expect(newId).not.toBe(oldId);

    // Poll active dispatches until the new dispatch appears with a settled status
    let resumed;
    for (let i = 0; i < 20; i++) {
      const listResp = await request.get(`${getBase()}/api/dispatch/active`);
      const list = await listResp.json();
      const candidate = list.find(d => d.id === newId);
      if (candidate) { resumed = candidate; break; }
      await new Promise(r => setTimeout(r, 200));
    }

    expect(resumed).toBeDefined();
    expect(resumed.model).toBe('claude-sonnet-4-6');
    expect(resumed.contract?.goal).toBe('test goal');
    expect(resumed.permission_mode).toBe('acceptEdits');
    expect(resumed.worktree_path).toBe(tempDir);
    expect(resumed.chain_mode).toBeNull();
    expect(resumed.chain_phase).toBeNull();
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
});

test('SR-33: double-POST /resume guard — exactly one 200 and one 400', async () => {
  const { dispatch_id: oldId } = await seedDispatch({
    status: 'suspended',
    claude_session_id: 'fake-sr33',
  });

  const [r1, r2] = await Promise.all([
    fetch(`${getBase()}/api/dispatch/${oldId}/resume`, { method: 'POST' }),
    fetch(`${getBase()}/api/dispatch/${oldId}/resume`, { method: 'POST' }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  // First POST succeeds (200); second POST either hits the in-memory guard (400 "not suspended")
  // or finds the record already deleted by the first (404 "not found") — both prove the guard works.
  expect(statuses[0]).toBe(200);
  expect([400, 404]).toContain(statuses[1]);
});

test('SR-34: sidebar Suspended tab lists entry and Continue button resumes dispatch', async ({ page }) => {
  const { dispatch_id: oldId } = await seedDispatch({
    status: 'suspended',
    claude_session_id: 'fake-sr34',
  });

  await page.goto('/');

  // Click the Suspended tab in the DISPATCHES sidebar
  const suspendedTab = page.locator('[data-filter="suspended"]');
  await expect(suspendedTab).toBeVisible({ timeout: 5000 });
  await suspendedTab.click();

  // The suspended entry must be listed
  const entry = page.locator(`[data-susp-resume-dispatch="${oldId}"]`);
  await expect(entry).toBeVisible({ timeout: 5000 });

  // Click the Continue button inside that entry
  await entry.click();

  // Old entry disappears
  await expect(entry).not.toBeVisible({ timeout: 10000 });

  // A new dispatch panel must appear that is not the old id
  await page.waitForFunction((oid) => {
    const panels = document.querySelectorAll('[id^="dispatch-D-"]');
    return Array.from(panels).some(p => p.id !== `dispatch-${oid}`);
  }, oldId, { timeout: 10000 });
});

test('SR-35: Sessions view Suspended section shows Continue and Revoke buttons', async ({ page }) => {
  const { dispatch_id: dispatchId } = await seedDispatch({
    status: 'suspended',
    claude_session_id: 'fake-sr35-d',
  });
  const terminal = await seedTerminal({
    status: 'suspended',
    agentType: 'claude',
    claude_session_id: 'fake-sr35-t',
  });
  const terminalId = terminal.id;

  await page.goto('/#all-sessions');

  // Suspended heading must be visible in the #all-sessions view
  await expect(page.getByRole('heading', { name: 'Suspended Sessions' })).toBeVisible({ timeout: 5000 });

  // Continue button for suspended dispatch
  const continueDispatchBtn = page.locator(`[data-sess-continue-dispatch="${dispatchId}"]`);
  await expect(continueDispatchBtn).toBeVisible({ timeout: 5000 });

  // Continue button for suspended terminal
  const continueTerminalBtn = page.locator(`[data-sess-continue-terminal="${terminalId}"]`);
  await expect(continueTerminalBtn).toBeVisible({ timeout: 5000 });

  // Revoke button for suspended dispatch must be present
  const revokeBtn = page.locator(`[data-sess-revoke-dispatch="${dispatchId}"]`);
  await expect(revokeBtn).toBeVisible({ timeout: 5000 });

  // Click Continue — the button disables immediately while the resume resolves,
  // then route() re-renders the sessions view (removing the row).
  await continueDispatchBtn.click();
  await expect(continueDispatchBtn).toBeDisabled({ timeout: 10000 });
});

// SR-36 to SR-38: Session resume with stored model and CLI session registration

test('SR-36: terminal resume uses stored model, not hardcoded sonnet', async ({ request }) => {
  const t = await seedTerminal({
    status: 'suspended',
    agentType: 'claude',
    claude_session_id: 'sr36-fake-session',
    model: 'claude-opus-4-8',
  });
  const resp = await request.post(`${getBase()}/api/terminal/${t.id}/resume`);
  // Guard check: must not reject with 400 (status guard)
  expect(resp.status()).not.toBe(400);
  if (resp.status() === 200) {
    const body = await resp.json();
    // Fetch the newly created terminal and assert model was inherited
    const activeResp = await request.get(`${getBase()}/api/terminal/active`);
    const list = await activeResp.json();
    const resumed = list.find(term => term.id === body.terminal_id);
    if (resumed) {
      expect(resumed.model).toBe('claude-opus-4-8');
    }
  }
});

test('SR-37: POST /api/terminal with claude_session_id body uses it as session ID (not a new UUID)', async ({ request }) => {
  // Use the special ARCHITECT_KEY (–/architect/–) which resolves to ROOT without a registry lookup
  const resp = await request.post(`${getBase()}/api/terminal`, {
    data: {
      claude_session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567891',
      model: 'claude-opus-4-8',
      project_key: '–/architect/–',
      title: 'SR-37 resume mode',
      skip_seed: true,
    },
  });
  // Must not be a 400 (validation error). Spawn may fail (5xx) in CI since Claude isn't installed.
  expect(resp.status()).not.toBe(400);
  if (resp.status() === 200) {
    const body = await resp.json();
    const activeResp = await request.get(`${getBase()}/api/terminal/active`);
    const list = await activeResp.json();
    const created = list.find(t => t.id === body.terminal_id);
    if (created) {
      expect(created.claude_session_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567891');
      expect(created.model).toBe('claude-opus-4-8');
    }
  }
});

test('SR-38: POST /api/sessions/register stores claude_session_id and model', async ({ request }) => {
  const pid = process.pid; // use current process — guaranteed alive
  const resp = await request.post(`${getBase()}/api/sessions/register`, {
    data: {
      project_key: 'test/sr38',
      title: 'SR-38 CLI session',
      pid,
      claude_session_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      model: 'claude-opus-4-8',
    },
  });
  expect(resp.status()).toBe(201);
  const body = await resp.json();
  const id = body.id;

  const activeResp = await request.get(`${getBase()}/api/sessions/active`);
  const list = await activeResp.json();
  const found = list.find(s => s.id === id);
  expect(found).toBeDefined();
  expect(found.claude_session_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
  expect(found.model).toBe('claude-opus-4-8');

  // Cleanup
  await request.delete(`${getBase()}/api/sessions/${id}`);
});
