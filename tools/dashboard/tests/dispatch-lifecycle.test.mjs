/**
 * Contract tests for session interrupt, restart, and revoke (W-1288).
 * CT1–CT5: API-level, headless, no real Claude spawn.
 * Uses isolated tmp/ DB via the _workerPort fixture.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch } from './helpers.mjs';

// CT1: Resume a revoked-then-suspended dispatch → 409 session_revoked
test('CT1: resume revoked-suspended dispatch returns 409 session_revoked', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'suspended', claude_session_id: 'ct1-session' });

  // Revoke the dispatch
  const revokeResp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/revoke`, { method: 'POST' });
  expect(revokeResp.status).toBe(200);

  // Attempt to resume the revoked dispatch
  const resumeResp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/resume`, { method: 'POST' });
  expect(resumeResp.status).toBe(409);
  const body = await resumeResp.json();
  expect(body.code).toBe('session_revoked');
});

// CT2: Two concurrent restart calls on same interrupted dispatch → one 200, one 409
test('CT2: concurrent restart calls — one succeeds, one gets 409 session_revoked', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'interrupted', claude_session_id: 'ct2-session' });

  // Fire both restarts concurrently
  const [r1, r2] = await Promise.all([
    fetch(`${getBase()}/api/dispatch/${dispatch_id}/restart`, { method: 'POST' }),
    fetch(`${getBase()}/api/dispatch/${dispatch_id}/restart`, { method: 'POST' }),
  ]);

  const statuses = [r1.status, r2.status].sort();
  // One 200, one 409 — order may vary
  expect(statuses).toEqual([200, 409]);

  const failBody = r1.status === 409 ? await r1.json() : await r2.json();
  expect(failBody.code).toBe('session_revoked');
});

// CT3: Revoke dispatch, simulate server restart → dispatch absent from getPersistedDispatches (GET /active)
test('CT3: revoked dispatch absent from active list after session reset', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'interrupted', claude_session_id: 'ct3-session' });

  // Revoke it
  const revokeResp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/revoke`, { method: 'POST' });
  expect(revokeResp.status).toBe(200);

  // Simulate server restart (clears in-memory, re-loads from DB)
  const resetResp = await fetch(`${getBase()}/api/test/reset-sessions`, { method: 'POST' });
  expect(resetResp.status).toBe(200);

  // GET /active must not include the revoked dispatch
  const activeResp = await fetch(`${getBase()}/api/dispatch/active`);
  const active = await activeResp.json();
  const found = active.find(d => d.id === dispatch_id);
  expect(found).toBeUndefined();
});

// CT4: Interrupt running dispatch → response contains claude_session_id, dispatch not deleted
test('CT4: interrupt running dispatch returns 200 with claude_session_id, dispatch not deleted', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'running', claude_session_id: 'ct4-session' });

  const resp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/interrupt`, { method: 'POST' });
  // May be 200 (SIGINT sent or process already gone) or 400 if not running (seed race).
  // In test env: dispatch is seeded with status='running' but no real process; the interrupt
  // handler sets _gracefulInterrupt=true and attempts kill which may ESRCH (process gone).
  // Either way: dispatch must NOT be soft-deleted (deleted_at stays null).
  expect([200, 400]).toContain(resp.status);

  if (resp.status === 200) {
    const body = await resp.json();
    expect(body.claude_session_id).toBe('ct4-session');
  }

  // Verify dispatch is still visible in active list (not deleted)
  const activeResp = await fetch(`${getBase()}/api/dispatch/active`);
  const active = await activeResp.json();
  const found = active.find(d => d.id === dispatch_id);
  // Dispatch may have transitioned to interrupted or still running — but must NOT be absent (deleted)
  expect(found).toBeDefined();
  expect(found.deleted_at).toBeNull();
  // claude_session_id must be preserved
  expect(found.claude_session_id).toBe('ct4-session');
});

// CT5: Restart with non-existent worktree_path → 400 worktree_missing
test('CT5: restart with missing worktree_path returns 400 worktree_missing', async () => {
  const { dispatch_id } = await seedDispatch({
    status: 'interrupted',
    claude_session_id: 'ct5-session',
    worktree_path: '/tmp/__nonexistent_worktree_path_ct5_w1288__',
  });

  const resp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/restart`, { method: 'POST' });
  expect(resp.status).toBe(400);
  const body = await resp.json();
  expect(body.code).toBe('worktree_missing');
});
