/**
 * API Contract Tests
 *
 * Headless tests — no browser required. Validates that all major REST endpoints
 * return the expected shapes and status codes.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedWorkItem, seedEpic, seedDispatch, seedTerminal, seedSessionHistory, api } from './helpers.mjs';

test.describe('API contracts @fast', () => {

  test('AC-1: GET /api/registry returns 200', async () => {
    const result = await api('registry');
    expect(result).toBeDefined();
  });

  test('AC-2: GET /api/backlog returns projects map', async () => {
    const result = await api('backlog');
    expect(result).toBeDefined();
    expect(typeof result.projects).toBe('object');
  });

  test('AC-3: POST /api/work-items creates item', async () => {
    const item = await api('work-items', {
      method: 'POST',
      body: JSON.stringify({ title: 'AC-3 item', status: 'draft', priority: 'medium', project_key: 'ticari/architect/main' }),
    });
    expect(item.id).toBeTruthy();
    expect(item.title).toBe('AC-3 item');
  });

  test('AC-4: PATCH /api/work-items/:id updates status', async () => {
    const item = await seedWorkItem({ title: 'PATCH test', tags: ['trivial'] });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'planned' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-progress' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-review' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'testing' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'preview' }) });
    const updated = await api(`work-items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });
    expect(updated.status).toBe('done');
  });

  test('AC-5: DELETE /api/work-items/:id soft-deletes item (status → cancelled)', async () => {
    const item = await seedWorkItem({ title: 'Delete test' });
    const resp = await api(`work-items/${item.id}`, { method: 'DELETE' });
    expect(resp.deleted).toBe(item.id);
    const updated = await api(`work-items/${item.id}`);
    expect(updated.status).toBe('cancelled');
  });

  test('AC-6: GET /api/epics returns array', async () => {
    const result = await api('epics');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-7: GET /api/dispatch/active returns array', async () => {
    const result = await api('dispatch/active');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-8: GET /api/terminal/active returns array', async () => {
    const result = await api('terminal/active');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-7a: GET /api/dispatch/active returns title and work_item_title when linked', async () => {
    const workItem = await seedWorkItem({ title: 'AC-7a dispatch work item' });
    const { dispatch_id } = await seedDispatch({ work_item_id: workItem.id, title: workItem.title });
    const result = await api('dispatch/active');
    const entry = result.find(d => d.id === dispatch_id);
    expect(entry).toBeDefined();
    expect(entry.title).toBe(workItem.title);
    expect(entry.work_item_title).toBe(workItem.title);
    expect(entry.epic_title).toBeNull();
  });

  test('AC-8a: GET /api/terminal/active returns work_item_title when linked', async () => {
    const workItem = await seedWorkItem({ title: 'AC-8a terminal work item' });
    const seeded = await seedTerminal({ work_item_id: workItem.id });
    const result = await api('terminal/active');
    const entry = result.find(t => t.id === seeded.id);
    expect(entry).toBeDefined();
    expect(entry.work_item_title).toBe(workItem.title);
    expect(entry.epic_title).toBeNull();
  });

  test('AC-9: GET /api/server/status returns pid and port', async () => {
    const result = await api('server/status');
    expect(typeof result.pid).toBe('number');
    expect(typeof result.port).toBe('number');
  });

  test('AC-10: DELETE nonexistent work item returns 404', async () => {
    // api() throws on non-ok status, so we call fetch directly
    const resp = await fetch(`${getBase()}/api/work-items/nonexistent-id-99999`, { method: 'DELETE' });
    expect(resp.status).toBe(404);
  });

  // --- Work item advanced routes ---

  test('AC-11: GET /api/sequences/next returns next IDs', async () => {
    const result = await api('sequences/next');
    expect(result).toHaveProperty('next_work_item_id');
    expect(result).toHaveProperty('next_epic_id');
  });

  test('AC-12: GET /api/work-items/:id returns single item', async () => {
    const item = await seedWorkItem({ title: 'AC-12 item' });
    const fetched = await api(`work-items/${item.id}`);
    expect(fetched.id).toBe(item.id);
    expect(fetched.title).toBe('AC-12 item');
  });

  test('AC-13: GET /api/work-items/:id returns 404 for unknown id', async () => {
    const resp = await fetch(`${getBase()}/api/work-items/W-99999999`);
    expect(resp.status).toBe(404);
  });

  test('AC-14: POST /api/work-items/:id/depend adds dependency', async () => {
    const itemA = await seedWorkItem({ title: 'AC-14 dep source' });
    const itemB = await seedWorkItem({ title: 'AC-14 dep target' });
    const updated = await api(`work-items/${itemA.id}/depend`, {
      method: 'POST',
      body: JSON.stringify({ targets: [itemB.id] }),
    });
    expect(updated.depends_on).toContain(itemB.id);
  });

  test('AC-15: DELETE /api/work-items/:id/depend removes dependency', async () => {
    const itemA = await seedWorkItem({ title: 'AC-15 dep source' });
    const itemB = await seedWorkItem({ title: 'AC-15 dep target' });
    await api(`work-items/${itemA.id}/depend`, {
      method: 'POST',
      body: JSON.stringify({ targets: [itemB.id] }),
    });
    const updated = await fetch(`${getBase()}/api/work-items/${itemA.id}/depend`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [itemB.id] }),
    });
    const body = await updated.json();
    expect(body.depends_on).not.toContain(itemB.id);
  });

  test('AC-16: GET /api/work-items/:id/plan returns plain text', async () => {
    const item = await seedWorkItem({ title: 'AC-16 plan' });
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/plan`);
    expect(resp.ok).toBe(true);
    const content = await resp.text();
    expect(typeof content).toBe('string');
  });

  test('AC-17: PUT /api/work-items/:id/plan saves plan content', async () => {
    const item = await seedWorkItem({ title: 'AC-17 plan' });
    const saved = await api(`work-items/${item.id}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ content: '# Plan for AC-17' }),
    });
    expect(saved.saved).toBe(true);
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/plan`);
    const content = await resp.text();
    expect(content).toContain('AC-17');
  });

  test('AC-18: GET /api/work-items/:id/doc returns plain text', async () => {
    const item = await seedWorkItem({ title: 'AC-18 doc' });
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/doc`);
    expect(resp.ok).toBe(true);
    const content = await resp.text();
    expect(typeof content).toBe('string');
  });

  test('AC-19: PUT /api/work-items/:id/doc saves doc content', async () => {
    const item = await seedWorkItem({ title: 'AC-19 doc' });
    const saved = await api(`work-items/${item.id}/doc`, {
      method: 'PUT',
      body: JSON.stringify({ content: '# Doc for AC-19' }),
    });
    expect(saved.saved).toBe(true);
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/doc`);
    const content = await resp.text();
    expect(content).toContain('AC-19');
  });

  test('AC-20: GET /api/work-items/:id/artifacts returns files array', async () => {
    const item = await seedWorkItem({ title: 'AC-20 artifacts' });
    const result = await api(`work-items/${item.id}/artifacts`);
    expect(result).toHaveProperty('files');
    expect(Array.isArray(result.files)).toBe(true);
  });

  test('AC-21: PUT /api/work-items/:id/artifacts/:file saves artifact', async () => {
    const item = await seedWorkItem({ title: 'AC-21 artifact write' });
    const saved = await api(`work-items/${item.id}/artifacts/notes.md`, {
      method: 'PUT',
      body: JSON.stringify({ content: '# Artifact AC-21' }),
    });
    expect(saved.saved).toBe(true);
  });

  test('AC-22: GET /api/work-items/:id/artifacts/:file returns artifact content', async () => {
    const item = await seedWorkItem({ title: 'AC-22 artifact read' });
    await api(`work-items/${item.id}/artifacts/notes.md`, {
      method: 'PUT',
      body: JSON.stringify({ content: '# AC-22 content' }),
    });
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/artifacts/notes.md`);
    expect(resp.ok).toBe(true);
    const content = await resp.text();
    expect(content).toContain('AC-22 content');
  });

  test('AC-23: DELETE /api/work-items/:id/artifacts/:file deletes artifact', async () => {
    const item = await seedWorkItem({ title: 'AC-23 artifact delete' });
    await api(`work-items/${item.id}/artifacts/notes.md`, {
      method: 'PUT',
      body: JSON.stringify({ content: '# to delete' }),
    });
    const deleted = await api(`work-items/${item.id}/artifacts/notes.md`, { method: 'DELETE' });
    expect(deleted.deleted).toBe('notes.md');
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/artifacts/notes.md`);
    expect(resp.status).toBe(404);
  });

  // --- Epic CRUD routes ---

  test('AC-24: POST /api/epics creates an epic', async () => {
    const epic = await api('epics', {
      method: 'POST',
      body: JSON.stringify({ title: 'AC-24 epic', status: 'active', priority: 'high' }),
    });
    expect(epic.id).toMatch(/^E-\d+$/);
    expect(epic.title).toBe('AC-24 epic');
  });

  test('AC-25: GET /api/epics/:id returns epic with items and progress', async () => {
    const epic = await seedEpic({ title: 'AC-25 epic' });
    const fetched = await api(`epics/${epic.id}`);
    expect(fetched.id).toBe(epic.id);
    expect(fetched).toHaveProperty('progress');
  });

  test('AC-26: GET /api/epics/:id returns 404 for unknown epic', async () => {
    const resp = await fetch(`${getBase()}/api/epics/E-99999999`);
    expect(resp.status).toBe(404);
  });

  test('AC-27: PATCH /api/epics/:id updates epic fields', async () => {
    const epic = await seedEpic({ title: 'AC-27 epic' });
    const updated = await api(`epics/${epic.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: 'AC-27 updated' }),
    });
    expect(updated.title).toBe('AC-27 updated');
  });

  test('AC-28: DELETE /api/epics/:id deletes epic', async () => {
    const epic = await seedEpic({ title: 'AC-28 epic' });
    const result = await api(`epics/${epic.id}`, { method: 'DELETE' });
    expect(result.archived).toBe(epic.id);
  });

  test('AC-29: POST /api/epics/:id/archive returns 400 for active epic', async () => {
    const epic = await seedEpic({ title: 'AC-29 active epic', status: 'active' });
    const resp = await fetch(`${getBase()}/api/epics/${epic.id}/archive`, { method: 'POST' });
    expect(resp.status).toBe(400);
  });

  test('AC-30: POST /api/epics/:id/archive succeeds for done epic', async () => {
    const epic = await seedEpic({ title: 'AC-30 done epic' });
    // createEpic always sets status to draft; patch to done first
    await api(`epics/${epic.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });
    const result = await api(`epics/${epic.id}/archive`, { method: 'POST' });
    expect(result).toBeDefined();
    expect(result.status).toBe('archived');
  });

  test('AC-31: POST /api/epics/:id/unlink unlinks work item from epic', async () => {
    const epic = await seedEpic({ title: 'AC-31 epic' });
    const item = await seedWorkItem({ title: 'AC-31 item' });
    await api(`epics/${epic.id}/link`, {
      method: 'POST',
      body: JSON.stringify({ work_item_ids: [item.id] }),
    });
    const result = await api(`epics/${epic.id}/unlink`, {
      method: 'POST',
      body: JSON.stringify({ work_item_id: item.id }),
    });
    expect(result.unlinked).toBe(item.id);
    expect(result.epic_id).toBe(epic.id);
  });

  test('AC-32: GET /api/epics/:id/plan returns plain text', async () => {
    const epic = await seedEpic({ title: 'AC-32 plan' });
    const resp = await fetch(`${getBase()}/api/epics/${epic.id}/plan`);
    expect(resp.ok).toBe(true);
    const content = await resp.text();
    expect(typeof content).toBe('string');
  });

  test('AC-33: PUT /api/epics/:id/plan saves plan', async () => {
    const epic = await seedEpic({ title: 'AC-33 plan' });
    const saved = await api(`epics/${epic.id}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ content: '# Epic plan AC-33' }),
    });
    expect(saved.saved).toBe(true);
    const resp = await fetch(`${getBase()}/api/epics/${epic.id}/plan`);
    const content = await resp.text();
    expect(content).toContain('AC-33');
  });

  test('AC-34: GET /api/epics/:id/doc returns plain text', async () => {
    const epic = await seedEpic({ title: 'AC-34 doc' });
    const resp = await fetch(`${getBase()}/api/epics/${epic.id}/doc`);
    expect(resp.ok).toBe(true);
    const content = await resp.text();
    expect(typeof content).toBe('string');
  });

  test('AC-35: PUT /api/epics/:id/doc saves doc', async () => {
    const epic = await seedEpic({ title: 'AC-35 doc' });
    const saved = await api(`epics/${epic.id}/doc`, {
      method: 'PUT',
      body: JSON.stringify({ content: '# Epic doc AC-35' }),
    });
    expect(saved.saved).toBe(true);
    const resp = await fetch(`${getBase()}/api/epics/${epic.id}/doc`);
    const content = await resp.text();
    expect(content).toContain('AC-35');
  });

  // --- Dispatch advanced routes ---

  test('AC-36: GET /api/dispatch/:id/log returns plain text for seeded dispatch', async () => {
    const { dispatch_id } = await seedDispatch({ output: ['line one', 'line two'] });
    const resp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/log`);
    expect(resp.ok).toBe(true);
    expect(resp.headers.get('content-type')).toContain('text/plain');
    const body = await resp.text();
    expect(typeof body).toBe('string');
  });

  test('AC-37: DELETE /api/dispatch/all returns killed count', async () => {
    const result = await api('dispatch/all', { method: 'DELETE' });
    expect(result).toHaveProperty('killed');
    expect(typeof result.killed).toBe('number');
  });

  test('AC-38: POST /api/dispatch/:id/suspend returns 400 for non-running dispatch', async () => {
    const { dispatch_id } = await seedDispatch({ status: 'completed' });
    const resp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/suspend`, { method: 'POST' });
    expect(resp.status).toBe(400);
  });

  test('AC-39: POST /api/dispatch/:id/suspend returns 400 when no claude_session_id', async () => {
    const { dispatch_id } = await seedDispatch({ status: 'running', claude_session_id: null });
    const resp = await fetch(`${getBase()}/api/dispatch/${dispatch_id}/suspend`, { method: 'POST' });
    expect(resp.status).toBe(400);
  });

  // --- Terminal routes ---

  test('AC-40: DELETE /api/terminal/all returns killed count', async () => {
    const result = await api('terminal/all', { method: 'DELETE' });
    expect(result).toHaveProperty('killed');
    expect(typeof result.killed).toBe('number');
  });

  // --- Session routes ---

  test('AC-41: GET /api/sessions/active returns array', async () => {
    const result = await api('sessions/active');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-42: DELETE /api/sessions/:id returns 404 for unknown session', async () => {
    const resp = await fetch(`${getBase()}/api/sessions/C-0000000000`, { method: 'DELETE' });
    expect(resp.status).toBe(404);
  });

  // --- Server management routes ---

  test('AC-43: GET /api/projects returns projects map', async () => {
    const result = await api('projects');
    expect(typeof result).toBe('object');
  });

  test('AC-44: POST /api/projects/sync returns synced count', async () => {
    const result = await api('projects/sync', { method: 'POST' });
    expect(result).toHaveProperty('synced');
    expect(typeof result.synced).toBe('number');
  });

  test('AC-45: GET /api/server/config returns port and paths', async () => {
    const result = await api('server/config');
    expect(typeof result.port).toBe('number');
    expect(result).toHaveProperty('log_file');
    expect(result).toHaveProperty('pid_file');
    expect(result.database).toBe('postgresql');
  });

  test('AC-46: GET /api/server/logs returns text', async () => {
    const resp = await fetch(`${getBase()}/api/server/logs`);
    expect(resp.ok).toBe(true);
    const content = await resp.text();
    expect(typeof content).toBe('string');
  });

  test('AC-47: GET /api/session-history returns array', async () => {
    const result = await api('session-history');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-48: GET /api/time-report returns today and overall breakdowns', async () => {
    const result = await api('time-report');
    expect(result).toHaveProperty('today');
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('today_total');
    expect(result).toHaveProperty('overall_total');
  });

  test('AC-49: GET /api/settings/preferences returns object', async () => {
    const result = await api('settings/preferences');
    expect(typeof result).toBe('object');
  });

  test('AC-49b: GET /api/settings/preferences exposes _models_catalog for the FE picker', async () => {
    const result = await api('settings/preferences');
    expect(Array.isArray(result._models_catalog)).toBe(true);
    expect(result._models_catalog.length).toBeGreaterThan(0);
    for (const m of result._models_catalog) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.label).toBe('string');
      expect(typeof m.supports1m).toBe('boolean');
      expect(typeof m.input).toBe('number');
      expect(typeof m.output).toBe('number');
    }
    // The catalog the FE renders must include the architect default (Opus 4.8).
    expect(result._models_catalog.map(m => m.id)).toContain('claude-opus-4-8');
  });

  test('AC-50: PUT /api/settings/preferences saves preference', async () => {
    const result = await api('settings/preferences', {
      method: 'PUT',
      body: JSON.stringify({ test_pref_ac50: 'true' }),
    });
    expect(typeof result).toBe('object');
  });

  test('AC-50b: PUT /api/settings/preferences skips underscore-prefixed (computed) keys', async () => {
    // Round-tripping the GET payload (which contains _models_catalog and other _-keys)
    // back through PUT must not persist those response-only fields.
    const before = await api('settings/preferences');
    const result = await api('settings/preferences', {
      method: 'PUT',
      body: JSON.stringify({ ...before, real_pref_ac50b: 'kept' }),
    });
    // Underscore keys never land in the persisted prefs table.
    expect(result._models_catalog).toBeUndefined();
    expect(result._dispatch_mode_default_global).toBeUndefined();
    // A normal key written in the same request is persisted.
    expect(result.real_pref_ac50b).toBe('kept');
  });

  // --- Portfolio routes ---

  test('AC-51: GET /api/orgs returns array of org names', async () => {
    const result = await api('orgs');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-52: POST /api/work-items/:id/depend returns 400 when targets missing', async () => {
    const item = await seedWorkItem({ title: 'AC-52 dep missing' });
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/depend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets: [] }),
    });
    expect(resp.status).toBe(400);
  });

  test('AC-53: GET /api/dispatch/:id/log returns 404 for unknown dispatch', async () => {
    const resp = await fetch(`${getBase()}/api/dispatch/D-nonexistent-9999/log`);
    expect(resp.ok).toBe(false);
  });

  test('AC-54: PUT /api/epics/:id/plan saves empty content without error', async () => {
    const epic = await seedEpic({ title: 'AC-54 empty plan' });
    const saved = await api(`epics/${epic.id}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ content: '' }),
    });
    expect(saved.saved).toBe(true);
  });

  test('AC-55: PUT /api/work-items/:id/artifacts/:file with unsupported extension returns 404', async () => {
    const item = await seedWorkItem({ title: 'AC-55 artifact ext' });
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/artifacts/notes.txt`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'test' }),
    });
    // Route only matches .md files — non-matching returns 404
    expect(resp.status).toBe(404);
  });

  test('AC-56: POST /api/epics/:id/archive returns 404 for unknown epic', async () => {
    const resp = await fetch(`${getBase()}/api/epics/E-99999999/archive`, { method: 'POST' });
    expect(resp.status).toBe(404);
  });

  test('AC-57: GET /api/work-items/:id/artifacts/:file returns 404 when artifact absent', async () => {
    const item = await seedWorkItem({ title: 'AC-57 no artifact' });
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/artifacts/absent.md`);
    expect(resp.status).toBe(404);
  });

  test('AC-58: PATCH /api/epics/:id returns 404 for unknown epic', async () => {
    const resp = await fetch(`${getBase()}/api/epics/E-99999999`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'nope' }),
    });
    expect(resp.status).toBe(404);
  });

  // --- Time report org-level grouping ---

  test('AC-59: GET /api/time-report?group=org returns org-aggregated today and overall', async () => {
    await seedSessionHistory({ project_key: 'orgA/proj1/comp1', duration_seconds: 120, cost_usd: 2.00 });
    const result = await api('time-report?group=org');
    expect(result).toHaveProperty('today');
    expect(result).toHaveProperty('overall');
    expect(result).toHaveProperty('today_total');
    expect(result).toHaveProperty('overall_total');
    // Rows should have 'org' field but NOT individual project/component
    expect(result.overall.length).toBeGreaterThan(0);
    expect(result.overall[0]).toHaveProperty('org');
    expect(result.overall[0]).toHaveProperty('sessions');
    expect(result.overall[0]).toHaveProperty('time_seconds');
    expect(result.overall[0]).toHaveProperty('cost_usd');
    // Org-grouped rows must not expose project/component detail
    expect(result.overall[0]).not.toHaveProperty('project');
    expect(result.overall[0]).not.toHaveProperty('component');
  });

  test('AC-60: GET /api/time-report?group=org aggregates across projects in same org', async () => {
    await seedSessionHistory({ project_key: 'orgB/proj1/comp1', duration_seconds: 100, cost_usd: 1.00 });
    await seedSessionHistory({ project_key: 'orgB/proj2/comp2', duration_seconds: 200, cost_usd: 3.00 });
    const result = await api('time-report?group=org');
    const orgBRows = result.overall.filter(r => r.org === 'orgB');
    expect(orgBRows).toHaveLength(1);
    expect(orgBRows[0].sessions).toBe(2);
    expect(orgBRows[0].time_seconds).toBe(300);
    expect(orgBRows[0].cost_usd).toBeCloseTo(4.00, 1);
  });

  test('AC-61: GET /api/time-report?group=org daily returns rows with org and day, no project_key', async () => {
    await seedSessionHistory({ project_key: 'orgC/proj1/comp1', duration_seconds: 60, cost_usd: 0.50 });
    const result = await api('time-report?group=org');
    expect(result).toHaveProperty('daily');
    expect(result.daily.length).toBeGreaterThan(0);
    expect(result.daily[0]).toHaveProperty('org');
    expect(result.daily[0]).toHaveProperty('day');
    expect(result.daily[0]).toHaveProperty('time_seconds');
    expect(result.daily[0]).not.toHaveProperty('project');
    expect(result.daily[0]).not.toHaveProperty('component');
  });

  test('AC-62: GET /api/time-report?group=org monthly returns rows with org and month, no project_key', async () => {
    await seedSessionHistory({ project_key: 'orgD/proj1/comp1', duration_seconds: 60, cost_usd: 0.50 });
    const result = await api('time-report?group=org');
    expect(result).toHaveProperty('monthly');
    expect(result.monthly.length).toBeGreaterThan(0);
    expect(result.monthly[0]).toHaveProperty('org');
    expect(result.monthly[0]).toHaveProperty('month');
    expect(result.monthly[0]).toHaveProperty('time_seconds');
    expect(result.monthly[0]).not.toHaveProperty('project');
    expect(result.monthly[0]).not.toHaveProperty('component');
  });

  test('AC-63: GET /api/time-report (no param) still returns project-level data', async () => {
    await seedSessionHistory({ project_key: 'orgE/proj1/comp1', duration_seconds: 60, cost_usd: 0.50 });
    const result = await api('time-report');
    expect(result.overall.length).toBeGreaterThan(0);
    expect(result.overall[0]).toHaveProperty('project_key');
    expect(result.overall[0]).toHaveProperty('project');
    expect(result.overall[0]).toHaveProperty('component');
  });

  // --- Portfolio tree traversal (special characters in names) ---

  test('AC-64: portfolio tree walk — all projects resolve including dotted names', async () => {
    const orgs = await api('orgs');
    expect(orgs.length).toBeGreaterThan(0);
    for (const org of orgs) {
      const projects = await api(`org/${org}/projects`);
      for (const proj of projects) {
        const resp = await fetch(`${getBase()}/api/project/${org}/${proj}`);
        expect(resp.ok, `GET /api/project/${org}/${proj} should return 200`).toBe(true);
        const files = await resp.json();
        expect(Array.isArray(files), `project ${org}/${proj} should return an array`).toBe(true);
      }
    }
  });

  // --- Soft delete (W-1140) ---

  test('SD-1: DELETE /api/work-items/:id preserves row with status cancelled', async () => {
    const item = await seedWorkItem({ title: 'SD-1 soft delete' });
    const del = await api(`work-items/${item.id}`, { method: 'DELETE' });
    expect(del.deleted).toBe(item.id);
    const fetched = await api(`work-items/${item.id}`);
    expect(fetched.id).toBe(item.id);
    expect(fetched.status).toBe('cancelled');
    // Cancelled items remain in backlog with status 'cancelled' (archived items are hidden, not cancelled)
    const backlog = await api('backlog');
    const allItems = Object.values(backlog.projects || {}).flatMap(p => p.items || []);
    const inBacklog = allItems.find(i => i.id === item.id);
    expect(inBacklog).toBeDefined();
    expect(inBacklog.status).toBe('cancelled');
  });

  test('SD-2: GET /api/dispatch/active excludes soft-deleted; include_deleted=true includes them', async () => {
    const d = await seedDispatch({ title: 'SD-2 to soft-delete' });
    const id = d.dispatch_id;
    await api(`dispatch/${id}`, { method: 'DELETE' });
    const active = await api('dispatch/active');
    expect(active.find(x => x.id === id)).toBeUndefined();
    const withDeleted = await api('dispatch/active?include_deleted=true');
    const found = withDeleted.find(x => x.id === id);
    expect(found).toBeDefined();
    expect(found.deleted_at).toBeTruthy();
  });

  test('SD-3: DELETE /api/dispatch/:id response contains deleted_at timestamp', async () => {
    const d = await seedDispatch({ title: 'SD-3 delete response check' });
    const id = d.dispatch_id;
    const res = await api(`dispatch/${id}`, { method: 'DELETE' });
    expect(res.status).toBe('killed');
    expect(res.id).toBe(id);
    expect(res.deleted_at).toBeTruthy();
    expect(new Date(res.deleted_at).getTime()).toBeGreaterThan(0);
  });

  test('SD-4: soft-deleting one dispatch does not affect other dispatches visibility', async () => {
    const keep = await seedDispatch({ title: 'SD-4 keep' });
    const remove = await seedDispatch({ title: 'SD-4 remove' });
    await api(`dispatch/${remove.dispatch_id}`, { method: 'DELETE' });
    const active = await api('dispatch/active');
    expect(active.find(x => x.id === keep.dispatch_id)).toBeDefined();
    expect(active.find(x => x.id === remove.dispatch_id)).toBeUndefined();
    const withDeleted = await api('dispatch/active?include_deleted=true');
    expect(withDeleted.length).toBeGreaterThanOrEqual(
      active.filter(x => x.id === keep.dispatch_id).length
    );
  });

  // --- Tags filter ---

  test('TF-1: GET /api/work-items?tags= filters by tag (OR semantics)', async () => {
    const tagA = `tf-1-alpha-${Date.now()}`;
    const tagB = `tf-1-beta-${Date.now()}`;
    const itemA = await seedWorkItem({ title: 'TF-1 item tagA', tags: [tagA] });
    const itemB = await seedWorkItem({ title: 'TF-1 item tagB', tags: [tagB] });
    await seedWorkItem({ title: 'TF-1 item no match', tags: ['unrelated-tf1'] });

    const result = await api(`work-items?tags=${tagA}&tags=${tagB}`);
    const ids = result.items.map(i => i.id);
    expect(ids).toContain(itemA.id);
    expect(ids).toContain(itemB.id);
    expect(result._meta.filters.tags).toEqual([tagA, tagB]);
  });

  test('TF-2: GET /api/backlog?tags= filters by tag', async () => {
    const tag = `tf-2-tag-${Date.now()}`;
    const item = await seedWorkItem({ title: 'TF-2 item', tags: [tag] });
    await seedWorkItem({ title: 'TF-2 untagged', tags: [] });

    const backlog = await api(`backlog?tags=${tag}`);
    const allItems = Object.values(backlog.projects || {}).flatMap(p => p.items || []);
    const ids = allItems.map(i => i.id);
    expect(ids).toContain(item.id);
    // Items without the tag must not appear
    const untaggedInResult = allItems.filter(i => !i.tags?.includes(tag));
    expect(untaggedInResult).toHaveLength(0);
  });

  test('SD-5: dispatches and terminals schema includes deleted_at column', async () => {
    const d = await seedDispatch({ title: 'SD-5 schema check dispatch' });
    const t = await seedTerminal({ title: 'SD-5 schema check terminal' });
    await api(`dispatch/${d.dispatch_id}`, { method: 'DELETE' });
    await api(`terminal/${t.id}`, { method: 'DELETE' });
    const deletedDispatches = await api('dispatch/active?include_deleted=true');
    const foundDispatch = deletedDispatches.find(x => x.id === d.dispatch_id);
    expect(foundDispatch).toBeDefined();
    expect(typeof foundDispatch.deleted_at).toBe('string');
    const deletedTerminals = await api('terminal/active?include_deleted=true');
    const foundTerminal = deletedTerminals.find(x => x.id === t.id);
    expect(foundTerminal).toBeDefined();
    expect(typeof foundTerminal.deleted_at).toBe('string');
  });
});
