/**
 * W-1289: Backend project-key filtering for read endpoints
 *
 * Verifies that ?project_key= scopes each list endpoint to a single project.
 * Tests run headless against the live test server — no browser required.
 */

import { test, expect } from './fixtures.mjs';
import { api, seedWorkItem, seedDispatch, seedTerminal, seedEpic, purgeAll } from './helpers.mjs';

const ARCH_KEY   = 'ticari/architect/main';
const CORTEX_KEY = 'ticari/cortex/main';
const PORTFOLIO_ENTRY = { worktree_mode: 'auto', worktree_setup: { branch: 'main' } };

test.describe('project-key filter @headless', () => {
  test.beforeAll(async () => {
    await purgeAll();
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: ARCH_KEY,   entry: PORTFOLIO_ENTRY }),
    });
    await api('test/seed-portfolio-entry', {
      method: 'POST',
      body: JSON.stringify({ project_key: CORTEX_KEY, entry: PORTFOLIO_ENTRY }),
    });
  });

  // ============================================================
  // Backlog
  // ============================================================

  test('PKF-1: backlog?project_key= returns only that project', async () => {
    await seedWorkItem({ project_key: ARCH_KEY,   title: 'PKF-1 arch item' });
    await seedWorkItem({ project_key: CORTEX_KEY, title: 'PKF-1 cortex item' });

    const result = await api(`backlog?project_key=${encodeURIComponent(ARCH_KEY)}`);
    const projectKeys = Object.keys(result.projects || {});

    expect(projectKeys).toContain(ARCH_KEY);
    expect(projectKeys).not.toContain(CORTEX_KEY);
    const items = result.projects[ARCH_KEY]?.items ?? [];
    expect(items.every(i => i.project_key === ARCH_KEY)).toBe(true);
  });

  test('PKF-2: backlog?project_key= returns empty projects on no match', async () => {
    const result = await api('backlog?project_key=nonexistent%2Fproject%2Fmain');
    expect(result.projects).toEqual({});
  });

  test('PKF-3: backlog without filter returns all projects (regression)', async () => {
    await seedWorkItem({ project_key: ARCH_KEY,   title: 'PKF-3 arch' });
    await seedWorkItem({ project_key: CORTEX_KEY, title: 'PKF-3 cortex' });

    const result = await api('backlog');
    const projectKeys = Object.keys(result.projects || {});
    expect(projectKeys).toContain(ARCH_KEY);
    expect(projectKeys).toContain(CORTEX_KEY);
  });

  test('PKF-4: backlog?org=&project_key= — project_key wins over org', async () => {
    await seedWorkItem({ project_key: ARCH_KEY,   title: 'PKF-4 arch' });
    await seedWorkItem({ project_key: CORTEX_KEY, title: 'PKF-4 cortex' });

    const result = await api(`backlog?org=ticari&project_key=${encodeURIComponent(ARCH_KEY)}`);
    const projectKeys = Object.keys(result.projects || {});
    expect(projectKeys).toContain(ARCH_KEY);
    expect(projectKeys).not.toContain(CORTEX_KEY);
  });

  // ============================================================
  // Work items
  // ============================================================

  test('PKF-5: work-items?project_key= returns only that project', async () => {
    await seedWorkItem({ project_key: ARCH_KEY,   title: 'PKF-5 arch' });
    await seedWorkItem({ project_key: CORTEX_KEY, title: 'PKF-5 cortex' });

    const result = await api(`work-items?project_key=${encodeURIComponent(ARCH_KEY)}`);
    const items = result.items;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.project_key === ARCH_KEY)).toBe(true);
    expect(items.some(i => i.project_key === CORTEX_KEY)).toBe(false);
  });

  // ============================================================
  // Dispatches
  // ============================================================

  test('PKF-6: dispatch/active?project_key= returns only matching dispatches', async () => {
    const arch   = await seedDispatch({ status: 'running', project_key: ARCH_KEY,   title: 'PKF-6 arch dispatch' });
    const cortex = await seedDispatch({ status: 'running', project_key: CORTEX_KEY, title: 'PKF-6 cortex dispatch' });

    const list = await api(`dispatch/active?project_key=${encodeURIComponent(ARCH_KEY)}`);
    const ids = list.map(d => d.id);
    expect(ids).toContain(arch.dispatch_id);
    expect(ids).not.toContain(cortex.dispatch_id);
  });

  test('PKF-7: dispatch/active?include_deleted=true&project_key= filters deleted rows too', async () => {
    const arch   = await seedDispatch({ status: 'completed', project_key: ARCH_KEY,   title: 'PKF-7 arch deleted' });
    const cortex = await seedDispatch({ status: 'completed', project_key: CORTEX_KEY, title: 'PKF-7 cortex deleted' });

    await api(`dispatch/${arch.dispatch_id}`,   { method: 'DELETE' });
    await api(`dispatch/${cortex.dispatch_id}`, { method: 'DELETE' });

    const list = await api(`dispatch/active?include_deleted=true&project_key=${encodeURIComponent(ARCH_KEY)}`);
    const ids = list.map(d => d.id);
    expect(ids).toContain(arch.dispatch_id);
    expect(ids).not.toContain(cortex.dispatch_id);
  });

  // ============================================================
  // Terminals
  // ============================================================

  test('PKF-8: terminal/active?project_key= returns only matching terminals', async () => {
    const arch   = await seedTerminal({ project_key: ARCH_KEY,   title: 'PKF-8 arch terminal' });
    const cortex = await seedTerminal({ project_key: CORTEX_KEY, title: 'PKF-8 cortex terminal' });

    const list = await api(`terminal/active?project_key=${encodeURIComponent(ARCH_KEY)}`);
    const ids = list.map(t => t.id);
    expect(ids).toContain(arch.id);
    expect(ids).not.toContain(cortex.id);
  });

  test('PKF-9: terminal/active?include_deleted=true&project_key= filters deleted terminals too', async () => {
    const arch   = await seedTerminal({ project_key: ARCH_KEY,   title: 'PKF-9 arch del' });
    const cortex = await seedTerminal({ project_key: CORTEX_KEY, title: 'PKF-9 cortex del' });

    await api(`terminal/${arch.id}`,   { method: 'DELETE' });
    await api(`terminal/${cortex.id}`, { method: 'DELETE' });

    const list = await api(`terminal/active?include_deleted=true&project_key=${encodeURIComponent(ARCH_KEY)}`);
    const ids = list.map(t => t.id);
    expect(ids).toContain(arch.id);
    expect(ids).not.toContain(cortex.id);
  });

  // ============================================================
  // CLI Sessions
  // ============================================================

  test('PKF-10: sessions/active?project_key= returns only matching sessions', async () => {
    const pid = process.pid;

    const archSession = await api('sessions/register', {
      method: 'POST',
      body: JSON.stringify({ project_key: ARCH_KEY,   title: 'PKF-10 arch session',   pid }),
    });
    const cortexSession = await api('sessions/register', {
      method: 'POST',
      body: JSON.stringify({ project_key: CORTEX_KEY, title: 'PKF-10 cortex session', pid }),
    });

    const list = await api(`sessions/active?project_key=${encodeURIComponent(ARCH_KEY)}`);
    const ids = list.map(s => s.id);
    expect(ids).toContain(archSession.id);
    expect(ids).not.toContain(cortexSession.id);

    await api(`sessions/${archSession.id}`,   { method: 'DELETE' });
    await api(`sessions/${cortexSession.id}`, { method: 'DELETE' });
  });

  // ============================================================
  // Epics
  // ============================================================

  test('PKF-11: epics?project_key= returns only epics linked to that project', async () => {
    const archEpic   = await seedEpic({ title: 'PKF-11 arch epic' });
    const cortexEpic = await seedEpic({ title: 'PKF-11 cortex epic' });

    await seedWorkItem({ project_key: ARCH_KEY,   title: 'PKF-11 arch item',   epic_id: archEpic.id });
    await seedWorkItem({ project_key: CORTEX_KEY, title: 'PKF-11 cortex item', epic_id: cortexEpic.id });

    const list = await api(`epics?project_key=${encodeURIComponent(ARCH_KEY)}`);
    const ids = list.map(e => e.id);
    expect(ids).toContain(archEpic.id);
    expect(ids).not.toContain(cortexEpic.id);
  });
});
