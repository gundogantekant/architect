/**
 * Waiting-State Visibility Contract Tests (W-1006)
 *
 * Tests the bridge logic that mirrors dispatch agent_phase=waiting_for_input
 * onto the linked work item's input_needed flag, and the work_item_input_needed
 * field added to GET /api/dispatch/active responses.
 *
 * All tests here MUST FAIL before implementation because:
 *   - work_item_input_needed field does not exist in GET /api/dispatch/active yet
 *   - bridge logic (agent_phase_bridge) does not exist yet
 *   - PATCH /api/dispatch/:id/agent-phase endpoint does not exist yet
 *
 * WS-1  Bridge sets input_needed=true on work item when phase→waiting_for_input
 * WS-2  Bridge clears input_needed only when last waiting_for_input dispatch resolves
 * WS-3  User-set input_needed (from≠agent_phase_bridge) is never cleared by bridge
 * WS-4b GET /api/dispatch/active includes work_item_input_needed field per entry
 * WS-5  Suspended dispatch count in active list reflects dispatches, not work items
 * WS-6b Signal color contract: waiting_for_input=amber, suspended=grey in API response
 * WS-7  Restart survival: input_needed persists after restoreSessions
 * WS-8a loadAwaitingAction fires on phase transition (browser E2E — skipped)
 * WS-8b Debounce: rapid phase changes trigger loadAwaitingAction at most once (skipped)
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedWorkItem, seedDispatch, api } from './helpers.mjs';

// Project key that exists in the seeded test portfolio (see server-utils.mjs →
// seedTestPortfolio). Using it ensures the sidebar tree renders a
// `.project-item[data-key=...]` row whose signal dot we can assert against.
const PORTFOLIO_KEY = 'test-org/test-proj.dotted/main';

// ---------------------------------------------------------------------------
// Helper: set agent_phase via the PATCH endpoint (to be implemented)
// ---------------------------------------------------------------------------

async function patchDispatchPhase(dispatchId, phase) {
  const resp = await fetch(`${getBase()}/api/dispatch/${dispatchId}/agent-phase`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
  return resp;
}

// ---------------------------------------------------------------------------
// Main suite
// ---------------------------------------------------------------------------

test.describe('Waiting-state visibility contracts @fast', () => {

  // -------------------------------------------------------------------------
  // WS-1: Phase transition to waiting_for_input sets input_needed on work item
  // -------------------------------------------------------------------------
  test('WS-1: phase→waiting_for_input sets input_needed=true with source agent_phase_bridge', async () => {
    const item = await seedWorkItem({ title: 'WS-1 waiting state' });

    // Seed a running dispatch linked to the work item
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      work_item_id: item.id,
      agent_phase: 'generating',
    });

    // Simulate phase transition to waiting_for_input via the PATCH endpoint.
    // NOTE: This endpoint (PATCH /api/dispatch/:id/agent-phase) does not exist yet —
    // it must be created as part of W-1006 implementation.
    const resp = await patchDispatchPhase(dispatch_id, 'waiting_for_input');
    expect(resp.ok, 'PATCH /api/dispatch/:id/agent-phase must return 2xx').toBe(true);

    // Bridge must have set input_needed on the work item
    const full = await api(`work-items/${item.id}`);
    expect(full.input_needed).toBe(true);
    expect(full.input_needed_from).toBe('agent_phase_bridge');
  });

  // -------------------------------------------------------------------------
  // WS-2: input_needed cleared only when ALL waiting_for_input dispatches resolve
  // -------------------------------------------------------------------------
  test('WS-2: input_needed stays true while a second dispatch remains waiting_for_input', async () => {
    const item = await seedWorkItem({ title: 'WS-2 dual dispatch' });

    const { dispatch_id: d1 } = await seedDispatch({
      status: 'running',
      work_item_id: item.id,
      agent_phase: 'generating',
    });
    const { dispatch_id: d2 } = await seedDispatch({
      status: 'running',
      work_item_id: item.id,
      agent_phase: 'generating',
    });

    // Both dispatches go to waiting_for_input
    await patchDispatchPhase(d1, 'waiting_for_input');
    await patchDispatchPhase(d2, 'waiting_for_input');

    let full = await api(`work-items/${item.id}`);
    expect(full.input_needed).toBe(true);
    expect(full.input_needed_from).toBe('agent_phase_bridge');

    // First dispatch resumes — second is still waiting
    const respD1Back = await patchDispatchPhase(d1, 'generating');
    expect(respD1Back.ok).toBe(true);

    full = await api(`work-items/${item.id}`);
    expect(full.input_needed).toBe(true); // must remain — d2 still waiting

    // Second dispatch also resumes — bridge should now clear the flag
    const respD2Back = await patchDispatchPhase(d2, 'generating');
    expect(respD2Back.ok).toBe(true);

    full = await api(`work-items/${item.id}`);
    expect(full.input_needed).toBe(false); // cleared — no more waiting dispatches
  });

  // -------------------------------------------------------------------------
  // WS-3: User-set input_needed (from='user') is never auto-cleared by bridge
  // -------------------------------------------------------------------------
  test('WS-3: user-set input_needed is not cleared when bridge processes phase transitions', async () => {
    const item = await seedWorkItem({ title: 'WS-3 user flag preserved' });

    // Manually set input_needed with source 'user' via existing PATCH endpoint
    const setResp = await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, from: 'user', reason: 'Needs design decision' }),
    });
    expect(setResp.ok).toBe(true);

    // Seed a running dispatch linked to the work item
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      work_item_id: item.id,
      agent_phase: 'generating',
    });

    // Phase through waiting_for_input and back to generating
    await patchDispatchPhase(dispatch_id, 'waiting_for_input');
    await patchDispatchPhase(dispatch_id, 'generating');

    // User-set flag must be untouched
    const full = await api(`work-items/${item.id}`);
    expect(full.input_needed).toBe(true);
    expect(full.input_needed_from).toBe('user');
  });

  // -------------------------------------------------------------------------
  // WS-4b: GET /api/dispatch/active includes work_item_input_needed per dispatch
  // -------------------------------------------------------------------------
  test('WS-4b: GET /api/dispatch/active includes work_item_input_needed field', async () => {
    const item = await seedWorkItem({ title: 'WS-4b input needed field' });
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      work_item_id: item.id,
      agent_phase: 'generating',
    });

    const list = await api('dispatch/active');
    const entry = list.find(d => d.id === dispatch_id);
    expect(entry).toBeDefined();

    // Field must exist and be a boolean (false initially — no waiting phase yet)
    expect('work_item_input_needed' in entry).toBe(true);
    expect(typeof entry.work_item_input_needed).toBe('boolean');
    expect(entry.work_item_input_needed).toBe(false);

    // After phase transition, field must reflect true
    await patchDispatchPhase(dispatch_id, 'waiting_for_input');

    const listAfter = await api('dispatch/active');
    const entryAfter = listAfter.find(d => d.id === dispatch_id);
    expect(entryAfter.work_item_input_needed).toBe(true);
  });

  // -------------------------------------------------------------------------
  // WS-4b (no-work-item): work_item_input_needed is false when dispatch has no work_item_id
  // -------------------------------------------------------------------------
  test('WS-4b (no link): work_item_input_needed is false when dispatch has no work_item_id', async () => {
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      work_item_id: null,
      agent_phase: 'waiting_for_input',
    });

    const list = await api('dispatch/active');
    const entry = list.find(d => d.id === dispatch_id);
    expect(entry).toBeDefined();
    expect('work_item_input_needed' in entry).toBe(true);
    expect(entry.work_item_input_needed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // WS-5: Suspended dispatch count in active list reflects dispatches (not items)
  // -------------------------------------------------------------------------
  test('WS-5: suspended dispatch count in active list reflects dispatch count', async () => {
    // Seed two suspended dispatches linked to one work item
    const item = await seedWorkItem({ title: 'WS-5 suspended count' });
    const { dispatch_id: s1 } = await seedDispatch({
      status: 'suspended',
      work_item_id: item.id,
      claude_session_id: 'fake-ws5-s1',
    });
    const { dispatch_id: s2 } = await seedDispatch({
      status: 'suspended',
      work_item_id: item.id,
      claude_session_id: 'fake-ws5-s2',
    });
    // One running dispatch for baseline
    const { dispatch_id: r1 } = await seedDispatch({
      status: 'running',
      work_item_id: item.id,
    });

    const list = await api('dispatch/active');
    const suspendedInList = list.filter(d => d.status === 'suspended' && [s1, s2].includes(d.id));
    expect(suspendedInList).toHaveLength(2); // both suspended dispatches appear
    const runningInList = list.filter(d => d.id === r1);
    expect(runningInList).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // WS-6b: Signal color contract — waiting_for_input→amber, suspended→grey
  //
  // The color mapping is a pure function of agent_phase/status in the client.
  // Since getSignalColor() is not exported yet (browser-only inline code),
  // this test asserts the API-observable proxy: the `needs_input` boolean
  // and `status` fields returned by GET /api/dispatch/active should allow
  // the client to derive the correct colors. If a `signal_color` or similar
  // field is added by implementation, update this test to assert its value.
  // -------------------------------------------------------------------------
  test('WS-6b: active list encodes correct phase/status for amber/grey signal derivation', async () => {
    const { dispatch_id: waitingId } = await seedDispatch({
      status: 'running',
      agent_phase: 'waiting_for_input',
    });
    const { dispatch_id: suspendedId } = await seedDispatch({
      status: 'suspended',
      claude_session_id: 'fake-ws6b',
    });

    const list = await api('dispatch/active');

    const waiting = list.find(d => d.id === waitingId);
    expect(waiting).toBeDefined();
    // waiting_for_input → amber signal: agent_phase must be 'waiting_for_input'
    expect(waiting.agent_phase).toBe('waiting_for_input');
    expect(waiting.needs_input).toBe(true);

    const suspended = list.find(d => d.id === suspendedId);
    expect(suspended).toBeDefined();
    // suspended → grey signal: status must be 'suspended', agent_phase null
    expect(suspended.status).toBe('suspended');
    expect(suspended.agent_phase).toBeNull();

    // TODO: When implementation adds an explicit `signal_color` or `phase_color`
    // field to the active list response, assert:
    //   expect(waiting.signal_color).toBe('amber');
    //   expect(suspended.signal_color).toBe('grey');
  });

  // -------------------------------------------------------------------------
  // WS-7: Restart survival — input_needed=true (set by bridge) retained after restoreSessions
  // -------------------------------------------------------------------------
  test('WS-7: work item retains input_needed=true after server restart simulation', async () => {
    const item = await seedWorkItem({ title: 'WS-7 restart survival' });
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      work_item_id: item.id,
      agent_phase: 'generating',
    });

    // Bridge sets the flag
    const phaseResp = await patchDispatchPhase(dispatch_id, 'waiting_for_input');
    expect(phaseResp.ok, 'PATCH /api/dispatch/:id/agent-phase must succeed').toBe(true);

    const before = await api(`work-items/${item.id}`);
    expect(before.input_needed).toBe(true);
    expect(before.input_needed_from).toBe('agent_phase_bridge');

    // Simulate server restart by calling the test reset-sessions endpoint
    // (clears in-memory state and restores from DB, matching restoreSessions behavior)
    const resetResp = await fetch(`${getBase()}/api/test/reset-sessions`, { method: 'POST' });
    expect(resetResp.ok).toBe(true);

    // Work item flag must survive — it is persisted in the DB, not in memory
    const after = await api(`work-items/${item.id}`);
    expect(after.input_needed).toBe(true);
    expect(after.input_needed_from).toBe('agent_phase_bridge');
  });

  // -------------------------------------------------------------------------
  // WS-8a: sidebar session-entry dot gets `needs-input` when a linked dispatch
  //        is waiting_for_input, and reverts when the phase clears (browser E2E)
  //
  // Asserts CLASS PRESENCE (`needs-input`), never a hardcoded rgb — the colour
  // comes from var(--green) and must survive theming.
  // -------------------------------------------------------------------------
  test('WS-8a: sidebar dot gains/loses needs-input class on waiting_for_input transition', async ({ page }) => {
    const item = await seedWorkItem({ title: 'WS-8a sidebar dot', project_key: PORTFOLIO_KEY });
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      project_key: PORTFOLIO_KEY,
      work_item_id: item.id,
      agent_phase: 'generating',
    });

    await page.goto('/');

    // The DISPATCHES sidebar refreshes on a 3s interval; wait for our entry.
    const entry = page.locator('#dispatches-list .session-entry').filter({ hasText: item.id });
    await expect(entry).toBeVisible({ timeout: 10_000 });

    const dot = entry.locator('.status-dot');
    // Initially generating/running — not waiting for input.
    await expect(dot).not.toHaveClass(/needs-input/);

    // Transition the dispatch to waiting_for_input.
    const resp = await patchDispatchPhase(dispatch_id, 'waiting_for_input');
    expect(resp.ok).toBe(true);

    // activeDispatches refresh (restoreDispatches) polls every 10s — allow headroom.
    await expect(dot).toHaveClass(/needs-input/, { timeout: 15_000 });

    // Clear the waiting state — dot must revert (no longer needs-input).
    const back = await patchDispatchPhase(dispatch_id, 'generating');
    expect(back.ok).toBe(true);
    await expect(dot).not.toHaveClass(/needs-input/, { timeout: 15_000 });
  });

  // -------------------------------------------------------------------------
  // WS-8b: the parent project row signal dot gains `needs-input` while a
  //        dispatch under that project is waiting_for_input (browser E2E)
  //
  // Asserts CLASS PRESENCE on `.project-item[data-key] .signal-dot`, not rgb.
  // -------------------------------------------------------------------------
  test('WS-8b: project row signal dot gains needs-input while a dispatch waits for input', async ({ page }) => {
    const item = await seedWorkItem({ title: 'WS-8b project dot', project_key: PORTFOLIO_KEY });
    const { dispatch_id } = await seedDispatch({
      status: 'running',
      project_key: PORTFOLIO_KEY,
      work_item_id: item.id,
      agent_phase: 'generating',
    });

    await page.goto('/');

    // Project row for the seeded portfolio project must render in the tree.
    const projectDot = page.locator(`.project-item[data-key="${PORTFOLIO_KEY}"] .signal-dot`);
    await expect(projectDot).toBeVisible({ timeout: 10_000 });
    await expect(projectDot).not.toHaveClass(/needs-input/);

    // Dispatch waits for input → project signal dot must reflect needs-input.
    const resp = await patchDispatchPhase(dispatch_id, 'waiting_for_input');
    expect(resp.ok).toBe(true);
    await expect(projectDot).toHaveClass(/needs-input/, { timeout: 15_000 });

    // Resolve the wait → project dot reverts.
    const back = await patchDispatchPhase(dispatch_id, 'generating');
    expect(back.ok).toBe(true);
    await expect(projectDot).not.toHaveClass(/needs-input/, { timeout: 15_000 });
  });

});
