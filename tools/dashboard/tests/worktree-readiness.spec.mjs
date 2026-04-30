/**
 * Worktree Readiness Check Contract Tests (W-948)
 *
 * Validates the pre-dispatch worktree readiness check:
 * - POST /api/dispatch returns { warning, require_confirm: true } (HTTP 200) when
 *   portfolioEntry.worktree_setup is absent and worktree creation would occur.
 * - Adding confirm_worktree_warning: true bypasses the warning and proceeds.
 * - checkWorktreeReadiness logic correctly handles all portfolioEntry shapes.
 *
 * WR-1 and WR-2 are integration tests via /api/dispatch.
 * WR-3 through WR-8 are logic tests via /api/test/worktree-readiness-check.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api, purgeAll, seedWorkItem } from './helpers.mjs';

const TEST_PROJECT_KEY = 'test/readiness/main';
const TEST_PROJECT_PATH = '/Users/tekantgundogan/Documents/architect';

test.describe('Worktree Readiness Check @fast', () => {

  test.beforeEach(async () => {
    await purgeAll();
  });

  test.afterEach(async () => {
    await api('test/seed-portfolio-entry', {
      method: 'DELETE',
      body: JSON.stringify({ project_key: TEST_PROJECT_KEY, project_path: TEST_PROJECT_PATH }),
    });
  });

  // --- Integration tests via /api/dispatch ---

  test('WR-1: warning fires when worktree_setup is absent (integration)', async () => {
    const base = getBase();
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({
        project_key: TEST_PROJECT_KEY,
        project_path: TEST_PROJECT_PATH,
        entry: { worktree_mode: 'auto' },
      }),
    });
    const wi = await seedWorkItem({ title: 'WR-1 test', status: 'planned', project_key: TEST_PROJECT_KEY });

    const resp = await fetch(`${base}/api/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_item_id: wi.id,
        project_key: TEST_PROJECT_KEY,
        permission_mode: 'acceptEdits',
      }),
    });

    expect(resp.status).toBe(200);
    const result = await resp.json();
    expect(result.require_confirm).toBe(true);
    expect(result.warning).toContain('worktree_setup');
    expect(result.warning).toContain(TEST_PROJECT_KEY);
    expect(result.warning).toContain('/onboard <path> rescan');
  });

  test('WR-2: no warning when confirm_worktree_warning=true (integration)', async () => {
    const base = getBase();
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({
        project_key: TEST_PROJECT_KEY,
        project_path: TEST_PROJECT_PATH,
        entry: { worktree_mode: 'auto' },
      }),
    });
    const wi = await seedWorkItem({ title: 'WR-2 test', status: 'planned', project_key: TEST_PROJECT_KEY });

    const resp = await fetch(`${base}/api/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_item_id: wi.id,
        project_key: TEST_PROJECT_KEY,
        permission_mode: 'acceptEdits',
        confirm_worktree_warning: true,
      }),
    });

    const result = await resp.json();
    expect(result.require_confirm).toBeUndefined();
  });

  // --- Logic tests via /api/test/worktree-readiness-check ---

  test('WR-3: no warning when worktree_setup is { copy_paths: [], post_commands: [] }', async () => {
    const result = await api('test/worktree-readiness-check', {
      method: 'POST',
      body: JSON.stringify({
        portfolio_entry: { worktree_setup: { copy_paths: [], post_commands: [] } },
        project_key: TEST_PROJECT_KEY,
      }),
    });
    expect(result.warning_result).toBeNull();
  });

  test('WR-4: warning fires when portfolioEntry.worktree_setup is null', async () => {
    const result = await api('test/worktree-readiness-check', {
      method: 'POST',
      body: JSON.stringify({
        portfolio_entry: { worktree_mode: 'auto', worktree_setup: null },
        project_key: TEST_PROJECT_KEY,
      }),
    });
    expect(result.warning_result).not.toBeNull();
    expect(result.warning_result.require_confirm).toBe(true);
    expect(result.warning_result.warning).toContain('worktree_setup');
  });

  test('WR-5: warning fires when portfolioEntry is null', async () => {
    const result = await api('test/worktree-readiness-check', {
      method: 'POST',
      body: JSON.stringify({
        portfolio_entry: null,
        project_key: TEST_PROJECT_KEY,
      }),
    });
    expect(result.warning_result).not.toBeNull();
    expect(result.warning_result.require_confirm).toBe(true);
    expect(result.warning_result.warning).toContain('worktree_setup');
  });

  test('WR-6: no warning when worktree_setup is {} (empty object is truthy)', async () => {
    const result = await api('test/worktree-readiness-check', {
      method: 'POST',
      body: JSON.stringify({
        portfolio_entry: { worktree_setup: {} },
        project_key: TEST_PROJECT_KEY,
      }),
    });
    expect(result.warning_result).toBeNull();
  });

  test('WR-7: no warning when worktree_setup has copy_paths: [] only', async () => {
    const result = await api('test/worktree-readiness-check', {
      method: 'POST',
      body: JSON.stringify({
        portfolio_entry: { worktree_setup: { copy_paths: [] } },
        project_key: TEST_PROJECT_KEY,
      }),
    });
    expect(result.warning_result).toBeNull();
  });

  test('WR-8: warning fires when worktree_setup is undefined (absent field)', async () => {
    const result = await api('test/worktree-readiness-check', {
      method: 'POST',
      body: JSON.stringify({
        portfolio_entry: { worktree_mode: 'auto' },
        project_key: TEST_PROJECT_KEY,
      }),
    });
    expect(result.warning_result).not.toBeNull();
    expect(result.warning_result.require_confirm).toBe(true);
    expect(result.warning_result.warning).toContain(TEST_PROJECT_KEY);
  });

});
