/**
 * Server-side contract tests for POST /api/projects/:org/:proj/:comp/refine-terminal
 *
 * RT-1: draft item present → 200 with terminal_id and accepted:true
 * RT-2: all items blocked  → 400 { error: "no eligible items for refinement", count: 0 }
 * RT-3: second call while first session alive → 409
 * RT-4: live project_refinement dispatch running → 409
 * RT-5: project.path does not exist on disk → 200 (falls back to ROOT)
 */

import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedProject(base, opts = {}) {
  const org = opts.org || 'rtorg';
  const proj = opts.proj || 'rtproj';
  const comp = opts.comp || 'main';
  const res = await fetch(`${base}/_test/seed-portfolio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org, project: proj, component: comp, path: opts.path ?? '/tmp/rtproj' }),
  });
  const body = await res.json();
  return { org, proj, comp, projectKey: `${org}/${proj}/${comp}`, ...body };
}

async function seedWorkItem(base, opts = {}) {
  const res = await fetch(`${base}/_test/seed-work-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: opts.status || 'draft',
      title: opts.title || 'RT test item',
      project_key: opts.project_key || 'rtorg/rtproj/main',
    }),
  });
  return res.json();
}

async function postRefineTerminal(base, org = 'rtorg', proj = 'rtproj', comp = 'main') {
  return fetch(`${base}/api/projects/${org}/${proj}/${comp}/refine-terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function cleanupTerminal(base, terminalId) {
  if (terminalId) {
    await fetch(`${base}/api/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('refine-terminal contract @fast', () => {
  test('RT-1: project with ≥1 draft item → 200 with terminal_id and accepted:true; session visible in active list', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    await seedWorkItem(base, { status: 'draft', title: 'RT-1 draft item', project_key: 'rtorg/rtproj/main' });

    const resp = await postRefineTerminal(base);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.accepted).toBe(true);
    expect(typeof body.terminal_id).toBe('string');
    expect(body.terminal_id.length).toBeGreaterThan(0);

    try {
      const activeRes = await fetch(`${base}/api/terminal/active`);
      expect(activeRes.status).toBe(200);
      const active = await activeRes.json();
      expect(Array.isArray(active)).toBe(true);
      const found = active.find(t => t.id === body.terminal_id || t.terminal_id === body.terminal_id);
      expect(found).toBeTruthy();
    } finally {
      await cleanupTerminal(base, body.terminal_id);
    }
  });

  test('RT-2: all items blocked → 400 { error: "no eligible items for refinement", count: 0 }; no terminal spawned', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    await seedWorkItem(base, { status: 'blocked', title: 'RT-2 blocked item', project_key: 'rtorg/rtproj/main' });

    const resp = await postRefineTerminal(base);
    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBe('no eligible items for refinement');
    expect(body.count).toBe(0);

    // No terminal should have been created
    const activeRes = await fetch(`${base}/api/terminal/active`);
    expect(activeRes.status).toBe(200);
    const active = await activeRes.json();
    // There should not be a refine session for this project key
    const refineSession = active.find(t => t.project_key === 'rtorg/rtproj/main');
    expect(refineSession).toBeFalsy();
  });

  test('RT-3: second call while first session alive → 409; first terminal still running', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    await seedWorkItem(base, { status: 'draft', title: 'RT-3 item', project_key: 'rtorg/rtproj/main' });

    const first = await postRefineTerminal(base);
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.accepted).toBe(true);

    let secondBody = null;
    try {
      const second = await postRefineTerminal(base);
      expect(second.status).toBe(409);
      secondBody = await second.json().catch(() => null);

      // First terminal should still be in the active list
      const activeRes = await fetch(`${base}/api/terminal/active`);
      const active = await activeRes.json();
      const found = active.find(t => t.id === firstBody.terminal_id || t.terminal_id === firstBody.terminal_id);
      expect(found).toBeTruthy();
    } finally {
      await cleanupTerminal(base, firstBody.terminal_id);
      if (secondBody?.terminal_id) await cleanupTerminal(base, secondBody.terminal_id);
    }
  });

  test('RT-4: live project_refinement dispatch running for same project → 409', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    await seedWorkItem(base, { status: 'draft', title: 'RT-4 item', project_key: 'rtorg/rtproj/main' });

    const seedId = `D-rt4-new-${Date.now()}`;
    await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: seedId,
        status: 'running',
        project_key: 'rtorg/rtproj/main',
        title: 'RT-4 background refinement dispatch',
        dispatch_mode: 'project_refinement',
        // No PID → treated as potentially alive → must block
      }),
    });

    let terminalId = null;
    try {
      const resp = await postRefineTerminal(base);
      expect(resp.status).toBe(409);
      const body = await resp.json().catch(() => null);
      terminalId = body?.terminal_id ?? null;
    } finally {
      await fetch(`${base}/api/dispatch/${seedId}`, { method: 'DELETE' }).catch(() => {});
      await cleanupTerminal(base, terminalId);
    }
  });

  test('RT-5: project.path does not exist on disk → 200; terminal spawned using ROOT fallback', async () => {
    const base = getBase();
    // Use a path that definitely does not exist on disk
    await seedProject(base, { org: 'rtorg', proj: 'rtproj5', comp: 'main', path: '/nonexistent/path/that/does/not/exist' });
    await seedWorkItem(base, { status: 'draft', title: 'RT-5 item', project_key: 'rtorg/rtproj5/main' });

    const resp = await postRefineTerminal(base, 'rtorg', 'rtproj5', 'main');
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.accepted).toBe(true);
    expect(typeof body.terminal_id).toBe('string');

    await cleanupTerminal(base, body.terminal_id);
  });
});
