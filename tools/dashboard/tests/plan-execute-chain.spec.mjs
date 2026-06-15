/**
 * Plan-Then-Execute chained-dispatch behavioral tests.
 *
 * Behavioral specs that exercise the chain via the live (isolated-DB) test server
 * WITHOUT spawning a real `claude` process. The spawn-driven argv/cwd path is
 * covered at the unit level (plan-execute.test.mjs → buildPermissionArgs +
 * startExecutePhase) and by the manual post-merge smoke; this file covers the
 * state machine, guards, and persistence that need a server + DB round-trip.
 *
 * DB isolation: every spec runs on its own isolated PostgreSQL test database
 * (see fixtures.mjs). No test ever touches the real dashboard DB.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch, resetSessions, api } from './helpers.mjs';

const DEAD_PID = 2147483600; // an unused, almost-certainly-dead PID for restart tests

function planMarkerLog() {
  // A clean phase-1 plan log: an ExitPlanMode tool use followed by a terminal result event.
  return [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode' }] } }),
    JSON.stringify({ type: 'result' }),
  ];
}

test.describe('Plan-Then-Execute chain @behavioral', () => {

  // --- Default resolution exposed to the FE (Success #4, E2E #5) ---

  test('PEC-1: preferences payload resolves architect default to plan_execute and others to acceptEdits', async () => {
    const prefs = await api('settings/preferences');
    const byProject = prefs._dispatch_mode_default_by_project ?? {};
    // Architect canonical key seeded by migration 043.
    expect(byProject['ticari/architect/main']).toBe('plan_execute');
    // The en-dash architect dispatch key normalizes to the same default.
    const enDashKey = '–/architect/–';
    expect(byProject[enDashKey]).toBe('plan_execute');
    // Global fallback is acceptEdits — a non-architect project gets the safe default.
    expect(prefs._dispatch_mode_default_global).toBe('acceptEdits');
  });

  // --- Terminal route guard (security hardening, #10) ---

  test('PEC-2: POST /api/terminal with dispatch_mode plan_execute is rejected (headless-only mode)', async ({ request }) => {
    const resp = await request.post(`${getBase()}/api/terminal`, {
      headers: { 'Content-Type': 'application/json' },
      data: { project_key: 'ticari/architect/main', dispatch_mode: 'plan_execute' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/headless/i);
  });

  // --- /execute validation guards (E2E #3 negative cases, security) ---

  test('PEC-3: POST /:id/execute on a missing dispatch → 404', async ({ request }) => {
    const resp = await request.post(`${getBase()}/api/dispatch/D-does-not-exist/execute`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(404);
  });

  test('PEC-4: POST /:id/execute on a non-execute_pending dispatch → 400', async ({ request }) => {
    const { dispatch_id } = await seedDispatch({
      status: 'completed',
      chain_mode: 'plan_execute',
      chain_phase: 'plan',
      claude_session_id: 'sess-pec4',
    });
    const resp = await request.post(`${getBase()}/api/dispatch/${dispatch_id}/execute`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe('not_execute_pending');
  });

  test('PEC-5: POST /:id/execute on a non-chain dispatch → 400', async ({ request }) => {
    const { dispatch_id } = await seedDispatch({
      status: 'execute_pending',
      claude_session_id: 'sess-pec5',
      // no chain_mode → not a plan_execute phase-1 record
    });
    const resp = await request.post(`${getBase()}/api/dispatch/${dispatch_id}/execute`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe('not_chain_plan');
  });

  test('PEC-6: POST /:id/execute on an execute_pending chain with no session id → 400', async ({ request }) => {
    const { dispatch_id } = await seedDispatch({
      status: 'execute_pending',
      chain_mode: 'plan_execute',
      chain_phase: 'plan',
      claude_session_id: null,
    });
    const resp = await request.post(`${getBase()}/api/dispatch/${dispatch_id}/execute`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe('no_session_id');
  });

  // --- Restart survival (Success #7, E2E #7) ---

  test('PEC-7: a phase-1 plan_execute dispatch with a clean result log recovers to execute_pending after restart', async ({ request }) => {
    // Seed a "running" phase-1 plan dispatch whose process is gone (dead PID) and whose
    // JSONL log ends cleanly with an ExitPlanMode marker + result event.
    const id = `D-pec7-${Date.now()}`;
    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({
        id,
        status: 'running',
        pid: DEAD_PID,
        chain_mode: 'plan_execute',
        chain_phase: 'plan',
        chain_autostart: false,
        claude_session_id: 'sess-pec7',
        log_lines: planMarkerLog(),
        project_key: 'ticari/architect/main',
      }),
    });

    // Simulate server restart: in-memory cleared, state reloaded from DB + JSONL.
    await resetSessions();

    // Fetch without the worker header — restored dispatches lose their _testWorkerId tag.
    const activeResp = await request.get(`${getBase()}/api/dispatch/active`);
    const active = await activeResp.json();
    const found = active.find(d => d.id === id);
    expect(found, 'dispatch must survive restart').toBeDefined();
    expect(found.status, 'clean phase-1 plan recovers to the durable execute_pending checkpoint, never interrupted')
      .toBe('execute_pending');
  });

  // --- Atomic /execute guard against a double POST (FIX 3) ---

  test('PEC-9: two concurrent POST /:id/execute spawn exactly one phase-2; the loser is rejected', async ({ request }) => {
    const { dispatch_id } = await seedDispatch({
      status: 'execute_pending',
      chain_mode: 'plan_execute',
      chain_phase: 'plan',
      chain_autostart: false,
      claude_session_id: 'sess-pec9',
      model: 'claude-opus-4-8',
    });

    const fire = () => request.post(`${getBase()}/api/dispatch/${dispatch_id}/execute`, {
      headers: { 'Content-Type': 'application/json' },
    });
    const [a, b] = await Promise.all([fire(), fire()]);

    // Exactly one winner (200) and one loser (400 not_execute_pending or 409 execute_running).
    const okCount = [a, b].filter(r => r.ok()).length;
    expect(okCount, 'exactly one /execute must win the race').toBe(1);
    const loser = a.ok() ? b : a;
    expect([400, 409], `loser status was ${loser.status()}`).toContain(loser.status());
    const loserBody = await loser.json();
    expect(['not_execute_pending', 'execute_running']).toContain(loserBody.code);

    // Exactly one phase-2 (execute) child exists for this chain.
    const active = await (await request.get(`${getBase()}/api/dispatch/active`)).json();
    const children = active.filter(d => d.chain_parent_id === dispatch_id && d.chain_phase === 'execute');
    expect(children.length, 'a double POST must never produce two phase-2 dispatches').toBe(1);
  });

  // --- Phase-2 inherits the phase-1 model (FIX 2) ---

  test('PEC-10: phase-2 inherits the phase-1 model instead of defaulting to sonnet', async ({ request }) => {
    const { dispatch_id } = await seedDispatch({
      status: 'execute_pending',
      chain_mode: 'plan_execute',
      chain_phase: 'plan',
      chain_autostart: false,
      claude_session_id: 'sess-pec10',
      model: 'claude-opus-4-8',
    });

    const resp = await request.post(`${getBase()}/api/dispatch/${dispatch_id}/execute`, {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.ok(), `execute failed: ${resp.status()}`).toBeTruthy();
    const { dispatch_id: phase2Id } = await resp.json();

    const active = await (await request.get(`${getBase()}/api/dispatch/active`)).json();
    const phase2 = active.find(d => d.id === phase2Id);
    expect(phase2, 'phase-2 dispatch must exist').toBeDefined();
    expect(phase2.model, 'phase-2 must inherit the phase-1 opus model, not fall back to sonnet')
      .toBe('claude-opus-4-8');
  });

  test('PEC-8: a phase-1 plan_execute dispatch with a cut-off (no result) log recovers to interrupted, not execute_pending', async ({ request }) => {
    const id = `D-pec8-${Date.now()}`;
    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({
        id,
        status: 'running',
        pid: DEAD_PID,
        chain_mode: 'plan_execute',
        chain_phase: 'plan',
        claude_session_id: 'sess-pec8',
        // Trailing event is NOT a result → the turn was cut off mid-stream.
        log_lines: [
          JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode' }] } }),
          JSON.stringify({ type: 'content_block_delta', delta: { text: 'still typing' } }),
        ],
        project_key: 'ticari/architect/main',
      }),
    });

    await resetSessions();

    const activeResp = await request.get(`${getBase()}/api/dispatch/active`);
    const active = await activeResp.json();
    const found = active.find(d => d.id === id);
    expect(found).toBeDefined();
    expect(found.status, 'a cut-off plan phase must not be promoted to execute_pending').toBe('interrupted');
  });
});
