/**
 * Auto-Implement Dispatch Contract Tests
 *
 * Validates the POST /api/dispatch/auto-implement endpoint:
 * - Eligibility enforcement (status, deps, active dispatch, depth)
 * - dispatch_mode persistence
 * - Prompt content (# Auto-Implement Mode section)
 * - Active list response includes dispatch_mode
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api, purgeAll, seedWorkItem, seedDispatch } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';

test.describe('Auto-Implement Dispatch @fast', () => {

  test.beforeEach(async () => {
    await purgeAll();
  });

  // --- Eligibility: status rejections ---

  test('AI-1: rejects done work item', async ({ request }) => {
    const base = getBase();
    const wi = await seedWorkItem({ title: 'AI-1 test', status: 'done' });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: wi.id, project_key: PROJECT_KEY },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/done/i);
  });

  test('AI-2: rejects blocked work item', async ({ request }) => {
    const base = getBase();
    const wi = await seedWorkItem({ title: 'AI-2 test', status: 'in-progress' });
    // PATCH to blocked status (valid transition: in-progress → blocked)
    await api(`work-items/${wi.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'blocked' }),
    });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: wi.id, project_key: PROJECT_KEY },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/blocked/i);
  });

  // --- Eligibility: unmet dependencies ---

  test('AI-3: rejects when depends_on items not done', async ({ request }) => {
    const base = getBase();
    const blocker = await seedWorkItem({ title: 'AI-3 blocker', status: 'planned' });
    const dependent = await seedWorkItem({ title: 'AI-3 dependent', status: 'planned' });
    // Link dependency
    await api(`work-items/${dependent.id}/depend`, {
      method: 'POST',
      body: JSON.stringify({ targets: [blocker.id] }),
    });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: dependent.id, project_key: PROJECT_KEY },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain(blocker.id);
  });

  // --- Eligibility: active dispatch ---

  test('AI-4: rejects when active dispatch exists for work item', async ({ request }) => {
    const base = getBase();
    const wi = await seedWorkItem({ title: 'AI-4 test', status: 'planned' });
    await seedDispatch({ work_item_id: wi.id, status: 'running' });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: wi.id, project_key: PROJECT_KEY },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/already running/i);
  });

  // --- Depth validation ---

  test('AI-5: rejects when X-Architect-Session-Depth header is 1', async ({ request }) => {
    const base = getBase();
    const wi = await seedWorkItem({ title: 'AI-5 test', status: 'planned' });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: {
        'Content-Type': 'application/json',
        'X-Architect-Session-Depth': '1',
      },
      data: { work_item_id: wi.id, project_key: PROJECT_KEY },
    });
    expect(resp.status()).toBe(403);
    const body = await resp.json();
    expect(body.error).toMatch(/depth/i);
  });

  test('AI-5b: allows when X-Architect-Session-Depth header is absent', async ({ request }) => {
    // Checks depth validation doesn't block absent header.
    // Expects either 200 (project resolves) or 400 (project not in test env) — not 403.
    const base = getBase();
    const wi = await seedWorkItem({ title: 'AI-5b test', status: 'planned' });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: wi.id, project_key: PROJECT_KEY },
    });
    expect(resp.status()).not.toBe(403);
  });

  // --- Prompt content ---

  test('AI-6: prompt contains # Auto-Implement Mode section with implement-work-item path', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-auto-implement-prompt`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        workItem: { id: 'W-AI6', title: 'AI-6 test', status: 'planned', priority: 'medium' },
        projectKey: PROJECT_KEY,
        projectPath: '/tmp/test-project',
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();
    expect(prompt).toContain('# Auto-Implement Mode');
    expect(prompt).toContain('implement-work-item.md');
    expect(prompt).toContain('X-Architect-Session-Depth: 1');
  });

  test('AI-7: prompt does NOT embed implement-work-item.md text (references path only)', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-auto-implement-prompt`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        workItem: { id: 'W-AI7', title: 'AI-7 test', status: 'planned', priority: 'medium' },
        projectKey: PROJECT_KEY,
        projectPath: '/tmp/test-project',
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();
    // Full workflow steps must NOT be embedded in the prompt
    expect(prompt).not.toContain('## Steps\n\n1. **Fetch work item details**');
  });

  // --- Active list includes dispatch_mode ---

  test('AI-8: GET /api/dispatch/active includes dispatch_mode for auto_implement dispatch', async ({ request }) => {
    const base = getBase();
    const d = await seedDispatch({ status: 'running', dispatch_mode: 'auto_implement' });
    const resp = await request.get(`${base}/api/dispatch/active`);
    expect(resp.ok()).toBe(true);
    const list = await resp.json();
    const found = list.find(x => x.id === d.dispatch_id);
    expect(found).toBeTruthy();
    expect(found.dispatch_mode).toBe('auto_implement');
  });

  test('AI-9: standard dispatch defaults to dispatch_mode = standard in active list', async ({ request }) => {
    const base = getBase();
    const d = await seedDispatch({ status: 'running' });
    const resp = await request.get(`${base}/api/dispatch/active`);
    expect(resp.ok()).toBe(true);
    const list = await resp.json();
    const found = list.find(x => x.id === d.dispatch_id);
    expect(found).toBeTruthy();
    expect(found.dispatch_mode).toBe('standard');
  });

  // --- Worktree failure handling ---

  test('AI-10: returns 500 when worktree creation fails (non-git project path)', async ({ request }) => {
    const base = getBase();
    const fakeKey = 'test/fake-project/main';
    // Seed a registry entry pointing to a non-git path so resolveProjectPath succeeds
    // but createWorktreeForDispatch fails (git operations on /tmp will fail)
    await request.post(`${base}/api/test/seed-registry-entry`, {
      headers: { 'Content-Type': 'application/json' },
      data: { project_key: fakeKey, project_path: '/tmp' },
    });
    const wi = await seedWorkItem({ title: 'AI-10 test', status: 'planned' });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: wi.id, project_key: fakeKey },
    });
    expect(resp.status()).toBe(500);
    const body = await resp.json();
    expect(body.error).toMatch(/worktree/i);
  });
});
