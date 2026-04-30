/**
 * Autonomous Pipeline Contract Tests (W-956)
 *
 * AP-1 to AP-14: Headless API contract tests for the autonomous dispatch pipeline.
 *
 * These tests are INTENTIONALLY RED — the backend endpoints they target do not
 * exist yet. They define the expected contract for:
 *   - POST /api/dispatch/:id/complete  (agent signals completion with SHA + summary)
 *   - POST /api/dispatch/:id/merge     (orchestrator triggers merge; depth-0 only)
 *   - POST /api/dispatch/:id/merge/cancel  (user cancels pending merge)
 *   - GET  /api/settings/preferences   (merge_gate preference, default 'confirm')
 *   - PUT  /api/settings/preferences   (persist merge_gate: 'auto')
 *   - GET  /api/dispatch/active        (exposes merge_pending status + completion fields)
 *   - Session restore: merge_pending dispatches survive reset
 *
 * NOTE on seed-dispatch: the /api/test/seed-dispatch endpoint (as of writing) stores
 * dispatch objects in memory. It supports an arbitrary `status` field, so seeding
 * status='merge_pending' should work structurally. If the seed endpoint validates
 * status against an allowlist that excludes 'merge_pending', those tests will fail
 * at the seed step — which is expected and correct for this contract-first approach.
 *
 * Tags: @fast (all tests are pure API, no real git or PTY operations needed).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch, api } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

// ---------------------------------------------------------------------------
// Helper: raw fetch with depth header to avoid api() throwing on non-2xx
// ---------------------------------------------------------------------------

async function rawPost(path, body = {}, headers = {}) {
  const base = getBase();
  return fetch(`${base}/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function rawGet(path, headers = {}) {
  const base = getBase();
  return fetch(`${base}/api/${path}`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

async function rawPut(path, body = {}, headers = {}) {
  const base = getBase();
  return fetch(`${base}/api/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// AP-1: POST /complete returns 404 for unknown dispatch ID @fast
// ---------------------------------------------------------------------------

test('AP-1: POST /complete returns 404 for unknown dispatch ID @fast', async () => {
  const resp = await rawPost('dispatch/D-nonexistent/complete', { sha: 'abc123', summary: 'done' }, {
    'X-Architect-Session-Depth': '1',
  });
  expect(resp.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AP-2: POST /complete returns 403 when depth header is 0 or absent @fast
// ---------------------------------------------------------------------------

test('AP-2a: POST /complete returns 403 when X-Architect-Session-Depth is 0 @fast', async () => {
  // Seed a running auto_implement dispatch to get a valid ID
  const { dispatch_id } = await seedDispatch({ status: 'running', dispatch_mode: 'auto_implement' });

  const resp = await rawPost(`dispatch/${dispatch_id}/complete`, { sha: 'abc123', summary: 'done' }, {
    'X-Architect-Session-Depth': '0',
  });
  expect(resp.status).toBe(403);
});

test('AP-2b: POST /complete returns 403 when X-Architect-Session-Depth header is absent @fast', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'running', dispatch_mode: 'auto_implement' });

  const resp = await rawPost(`dispatch/${dispatch_id}/complete`, { sha: 'abc123', summary: 'done' });
  // No depth header at all — orchestrator caller (depth 0 equivalent) must not be able to call /complete
  expect(resp.status).toBe(403);
});

// ---------------------------------------------------------------------------
// AP-3: POST /complete returns 400 if dispatch is not running @fast
// ---------------------------------------------------------------------------

test('AP-3: POST /complete returns 400 if dispatch is not running @fast', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'completed', dispatch_mode: 'auto_implement' });

  const resp = await rawPost(`dispatch/${dispatch_id}/complete`, { sha: 'deadbeef', summary: 'already done' }, {
    'X-Architect-Session-Depth': '1',
  });
  expect(resp.status).toBe(400);
});

// ---------------------------------------------------------------------------
// AP-4: POST /complete transitions dispatch to merge_pending and stores sha/summary @fast
// ---------------------------------------------------------------------------

test('AP-4: POST /complete transitions dispatch to merge_pending and stores sha/summary @fast', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'running', dispatch_mode: 'auto_implement' });

  const resp = await rawPost(`dispatch/${dispatch_id}/complete`, {
    sha: 'deadbeef',
    summary: 'implemented feature',
  }, {
    'X-Architect-Session-Depth': '1',
  });

  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body.status).toBe('merge_pending');
  expect(body.dispatch_id).toBe(dispatch_id);

  // Verify the stored state via active list
  const listResp = await rawGet('dispatch/active');
  expect(listResp.ok).toBe(true);
  const list = await listResp.json();
  const found = list.find(d => d.id === dispatch_id);
  expect(found).toBeDefined();
  expect(found.status).toBe('merge_pending');
  expect(found.completion_sha).toBe('deadbeef');
  expect(found.completion_summary).toBe('implemented feature');
});

// ---------------------------------------------------------------------------
// AP-5: GET /api/dispatch/active includes merge_pending dispatch @fast
// ---------------------------------------------------------------------------

test('AP-5: GET /api/dispatch/active includes merge_pending dispatch @fast', async () => {
  // NOTE: Seeding status='merge_pending' directly. If seed-dispatch validates status
  // against an allowlist, this will fail at the seed step (expected, contract-first).
  const { dispatch_id } = await seedDispatch({ status: 'merge_pending', dispatch_mode: 'auto_implement' });

  const listResp = await rawGet('dispatch/active');
  expect(listResp.ok).toBe(true);
  const list = await listResp.json();
  const found = list.find(d => d.id === dispatch_id);
  expect(found).toBeDefined();
  expect(found.status).toBe('merge_pending');
});

// ---------------------------------------------------------------------------
// AP-6: POST /merge returns 403 when depth >= 1 @fast
// ---------------------------------------------------------------------------

test('AP-6: POST /merge returns 403 when depth >= 1 @fast', async () => {
  // NOTE: Seeding status='merge_pending' directly.
  const { dispatch_id } = await seedDispatch({ status: 'merge_pending', dispatch_mode: 'auto_implement' });

  // Only depth-0 (orchestrator) may trigger a merge; depth-1 agents must be rejected
  const resp = await rawPost(`dispatch/${dispatch_id}/merge`, {}, {
    'X-Architect-Session-Depth': '1',
  });
  expect(resp.status).toBe(403);
});

// ---------------------------------------------------------------------------
// AP-7: POST /merge/cancel returns 200 and preserves merge_pending status @fast
// ---------------------------------------------------------------------------

test('AP-7: POST /merge/cancel returns 200 and preserves merge_pending status @fast', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'merge_pending', dispatch_mode: 'auto_implement' });

  const resp = await rawPost(`dispatch/${dispatch_id}/merge/cancel`);
  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body.status).toBe('merge_pending');
  expect(body.cancelled).toBe(true);

  // Dispatch must still appear in active list with merge_pending status
  const listResp = await rawGet('dispatch/active');
  expect(listResp.ok).toBe(true);
  const list = await listResp.json();
  const found = list.find(d => d.id === dispatch_id);
  expect(found).toBeDefined();
  expect(found.status).toBe('merge_pending');
});

// ---------------------------------------------------------------------------
// AP-8: POST /merge/cancel returns 400 if dispatch not in merge_pending @fast
// ---------------------------------------------------------------------------

test('AP-8: POST /merge/cancel returns 400 if dispatch not in merge_pending @fast', async () => {
  const { dispatch_id } = await seedDispatch({ status: 'running', dispatch_mode: 'auto_implement' });

  const resp = await rawPost(`dispatch/${dispatch_id}/merge/cancel`);
  expect(resp.status).toBe(400);
});

// ---------------------------------------------------------------------------
// AP-9: GET /api/settings/preferences includes merge_gate with default 'confirm' @fast
// ---------------------------------------------------------------------------

test('AP-9: GET /api/settings/preferences includes merge_gate with default "confirm" @fast', async () => {
  const resp = await rawGet('settings/preferences');
  expect(resp.ok).toBe(true);
  const body = await resp.json();
  // merge_gate must default to 'confirm' (user must approve every merge)
  expect(body.merge_gate).toBe('confirm');
});

// ---------------------------------------------------------------------------
// AP-10: PUT /api/settings/preferences accepts merge_gate: 'auto' @fast
// ---------------------------------------------------------------------------

test('AP-10: PUT /api/settings/preferences accepts merge_gate: "auto" @fast', async () => {
  const putResp = await rawPut('settings/preferences', { merge_gate: 'auto' });
  expect(putResp.ok).toBe(true);

  const getResp = await rawGet('settings/preferences');
  expect(getResp.ok).toBe(true);
  const body = await getResp.json();
  expect(body.merge_gate).toBe('auto');
});

// ---------------------------------------------------------------------------
// AP-11: Auto-implement prompt contains /complete URL with no hardcoded 3777 @fast
// ---------------------------------------------------------------------------

test('AP-11: buildAutoImplementSection does not hardcode :3777 and references /complete @fast', async () => {
  // Source-level assertion: inspect prompt-builder.mjs to confirm the
  // buildAutoImplementSection function body references /complete and does not
  // hardcode the literal string ':3777'.
  //
  // When the /complete endpoint is implemented, the prompt builder must construct
  // the URL dynamically (e.g. from DASHBOARD_URL env or a passed-in base URL).

  const promptBuilderPath = join(ROOT, 'tools', 'dashboard', 'prompt-builder.mjs');
  const source = readFileSync(promptBuilderPath, 'utf8');

  // Extract the buildAutoImplementSection function body
  const fnStart = source.indexOf('function buildAutoImplementSection(');
  expect(fnStart).toBeGreaterThan(-1);
  // Find the closing brace of the function (next top-level function starts with 'export function' or 'function ')
  const afterFn = source.indexOf('\nexport function buildAutoImplementPrompt', fnStart);
  const fnBody = afterFn > -1 ? source.slice(fnStart, afterFn) : source.slice(fnStart, fnStart + 2000);

  // The function MUST reference /complete so dispatched agents know the endpoint
  expect(fnBody).toContain('/complete');

  // The function MUST NOT hardcode port 3777 — port must come from the DASHBOARD_URL
  // env var or be injected at call time, so tests with dynamic ports work correctly
  expect(fnBody).not.toContain(':3777');
});

// ---------------------------------------------------------------------------
// AP-12: merge_pending dispatch survives session reset when merge_gate=confirm @fast
// ---------------------------------------------------------------------------

test('AP-12: merge_pending dispatch survives session reset @fast', async () => {
  // Set the gate to confirm so the orchestrator must explicitly merge
  await rawPut('settings/preferences', { merge_gate: 'confirm' });

  // Seed a merge_pending dispatch
  const { dispatch_id } = await seedDispatch({
    status: 'merge_pending',
    dispatch_mode: 'auto_implement',
  });

  // Simulate a server session restore (clears in-memory state, reloads from DB)
  const resetResp = await rawPost('test/reset-sessions');
  expect(resetResp.ok).toBe(true);

  // The dispatch must still be visible with merge_pending status after restore
  const listResp = await rawGet('dispatch/active');
  expect(listResp.ok).toBe(true);
  const list = await listResp.json();
  const found = list.find(d => d.id === dispatch_id);
  expect(found).toBeDefined();
  expect(found.status).toBe('merge_pending');
});

// ---------------------------------------------------------------------------
// AP-13: merge_pending + merge_gate=auto readable from API (placeholder) @fast
// ---------------------------------------------------------------------------

test('AP-13 (placeholder): merge_pending dispatch + auto preference readable from API @fast', async () => {
  // Full merge-on-restart with mocking is not supported by the current test
  // infrastructure (no merge function mock injection). This placeholder verifies
  // the prerequisite state is correctly stored and readable — the actual
  // auto-merge-on-restart behavior must be verified separately once the backend
  // implementation provides a mockable merge hook.

  await rawPut('settings/preferences', { merge_gate: 'auto' });

  // Confirm preference round-trips
  const prefResp = await rawGet('settings/preferences');
  const prefs = await prefResp.json();
  expect(prefs.merge_gate).toBe('auto');

  // Seed a merge_pending dispatch
  const { dispatch_id } = await seedDispatch({
    status: 'merge_pending',
    dispatch_mode: 'auto_implement',
  });

  // Dispatch must be accessible from the active list
  const listResp = await rawGet('dispatch/active');
  expect(listResp.ok).toBe(true);
  const list = await listResp.json();
  const found = list.find(d => d.id === dispatch_id);
  expect(found).toBeDefined();
  expect(found.status).toBe('merge_pending');
  expect(found.dispatch_mode).toBe('auto_implement');
});

// ---------------------------------------------------------------------------
// AP-14: GET /api/dispatch/active exposes completion fields (even null) @fast
// ---------------------------------------------------------------------------

test('AP-14: GET /api/dispatch/active exposes completion_sha, completion_summary, merge_result (null) @fast', async () => {
  // A standard running (non-merge_pending) dispatch must still expose the
  // completion fields so the frontend can render them conditionally.
  const { dispatch_id } = await seedDispatch({ status: 'running', dispatch_mode: 'auto_implement' });

  const listResp = await rawGet('dispatch/active');
  expect(listResp.ok).toBe(true);
  const list = await listResp.json();
  const found = list.find(d => d.id === dispatch_id);
  expect(found).toBeDefined();

  // All three completion fields must be present (null when no completion has happened)
  expect(Object.prototype.hasOwnProperty.call(found, 'completion_sha')).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(found, 'completion_summary')).toBe(true);
  expect(Object.prototype.hasOwnProperty.call(found, 'merge_result')).toBe(true);
  expect(found.completion_sha).toBeNull();
  expect(found.completion_summary).toBeNull();
  expect(found.merge_result).toBeNull();
});
