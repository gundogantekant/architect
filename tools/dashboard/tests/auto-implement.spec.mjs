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

  // --- Non-git project handling ---

  test('AI-10: dispatches in-place for non-git project path (no worktree)', async ({ request }) => {
    const base = getBase();
    const fakeKey = 'test/fake-project/main';
    await request.post(`${base}/api/test/seed-registry-entry`, {
      headers: { 'Content-Type': 'application/json' },
      data: { project_key: fakeKey, project_path: '/tmp' },
    });
    const wi = await seedWorkItem({ title: 'AI-10 test', status: 'planned' });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: wi.id, project_key: fakeKey },
    });
    // Non-git path: isGitRepository('/tmp') = false → no worktree → dispatch in-place
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.id).toBeTruthy();
    expect(body.worktree_path).toBeNull();
    // Kill the spawned subprocess immediately to avoid orphaned claude processes
    await request.delete(`${base}/api/dispatch/${body.id}`);
  });

  test('AI-2b: rejects draft work item', async ({ request }) => {
    const base = getBase();
    const wi = await seedWorkItem({ title: 'AI-2b test', status: 'draft' });
    const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
      headers: { 'Content-Type': 'application/json' },
      data: { work_item_id: wi.id, project_key: PROJECT_KEY },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toMatch(/draft/i);
  });

  test('AI-11: worktree_at_dispatch feature flag off → no worktree for git project', async ({ request }) => {
    const base = getBase();
    // Get the server root (a known git repo) and seed a self-contained project entry
    const rootResp = await api('test/root-path');
    const rootPath = rootResp.root;
    const ai11Key = 'test/flag-off-ai11/main';
    await request.post(`${base}/api/test/seed-registry-entry`, {
      headers: { 'Content-Type': 'application/json' },
      data: { project_key: ai11Key, project_path: rootPath },
    });

    // Disable the worktree feature flag
    await api('settings/preferences', {
      method: 'PUT',
      body: JSON.stringify({ worktree_at_dispatch: 'false' }),
    });
    try {
      const wi = await seedWorkItem({ title: 'AI-11 test', status: 'planned' });
      const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
        headers: { 'Content-Type': 'application/json' },
        data: { work_item_id: wi.id, project_key: ai11Key },
      });
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body.worktree_path).toBeNull();
      await request.delete(`${base}/api/dispatch/${body.id}`);
    } finally {
      // Always restore the feature flag to prevent dirty state for other tests
      await api('settings/preferences', {
        method: 'PUT',
        body: JSON.stringify({ worktree_at_dispatch: 'true' }),
      });
    }
  });

  // --- Prompt preservation: additionalInstructions ---

  test('AI-13: prompt with additionalInstructions preserves Dispatch Instructions before Auto-Implement Mode', async ({ request }) => {
    const base = getBase();
    const userText = 'Re-dispatch note: use the new approach for step 4.';
    const resp = await request.post(`${base}/api/test/build-auto-implement-prompt`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        workItem: { id: 'W-AI13', title: 'AI-13 test', status: 'planned', priority: 'medium' },
        projectKey: PROJECT_KEY,
        projectPath: '/tmp/test-project',
        additionalInstructions: userText,
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();
    const diIdx = prompt.indexOf('# Dispatch Instructions');
    const amIdx = prompt.indexOf('# Auto-Implement Mode');
    const iwmIdx = prompt.indexOf('# Isolated Work Mandate');
    expect(diIdx).toBeGreaterThan(-1);
    expect(amIdx).toBeGreaterThan(-1);
    expect(iwmIdx).toBeGreaterThan(-1);
    expect(prompt).toContain(userText);
    expect(diIdx).toBeLessThan(amIdx);
    expect(amIdx).toBeLessThan(iwmIdx);
  });

  test('AI-14: prompt without additionalInstructions has Auto-Implement Mode before Isolated Work Mandate and no Dispatch Instructions', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-auto-implement-prompt`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        workItem: { id: 'W-AI14', title: 'AI-14 test', status: 'planned', priority: 'medium' },
        projectKey: PROJECT_KEY,
        projectPath: '/tmp/test-project',
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();
    expect(prompt).not.toContain('# Dispatch Instructions');
    const amIdx = prompt.indexOf('# Auto-Implement Mode');
    const iwmIdx = prompt.indexOf('# Isolated Work Mandate');
    expect(amIdx).toBeGreaterThan(-1);
    expect(iwmIdx).toBeGreaterThan(-1);
    expect(amIdx).toBeLessThan(iwmIdx);
  });

  test('AI-12: worktree_mode "none" in portfolio entry is respected by auto-implement', async ({ request }) => {
    const base = getBase();
    // Get the server's root path (a known git repo)
    const rootResp = await api('test/root-path');
    const rootPath = rootResp.root;

    const noneKey = 'test/no-worktree-ai12/main';
    await request.post(`${base}/api/test/seed-portfolio-entry`, {
      headers: { 'Content-Type': 'application/json' },
      data: {
        project_key: noneKey,
        project_path: rootPath,
        entry: { worktree_mode: 'none', worktree_setup: {} },
      },
    });

    try {
      const wi = await seedWorkItem({ title: 'AI-12 test', status: 'planned' });
      const resp = await request.post(`${base}/api/dispatch/auto-implement`, {
        headers: { 'Content-Type': 'application/json' },
        data: { work_item_id: wi.id, project_key: noneKey },
      });
      expect(resp.status()).toBe(200);
      const body = await resp.json();
      expect(body.worktree_path).toBeNull();
      await request.delete(`${base}/api/dispatch/${body.id}`);
    } finally {
      // Clean up the seeded portfolio entry
      await request.delete(`${base}/api/test/seed-portfolio-entry`, {
        headers: { 'Content-Type': 'application/json' },
        data: { project_key: noneKey, project_path: rootPath },
      });
    }
  });
});
