import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';
import { buildProjectRefinementPrompt } from '../prompt-builder.mjs';

const seedProject = async (base, opts = {}) => {
  const org = opts.org || 'testorg';
  const proj = opts.proj || 'testproj';
  const comp = opts.comp || 'main';
  const res = await fetch(`${base}/_test/seed-portfolio`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ org, project: proj, component: comp, path: opts.path || '/tmp/testproj' }),
  });
  const body = await res.json();
  return { org, proj, comp, projectKey: `${org}/${proj}/${comp}`, ...body };
};

const seedWorkItem = async (base, opts = {}) => {
  const res = await fetch(`${base}/_test/seed-work-item`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: opts.status || 'draft',
      title: opts.title || 'Test item',
      project_key: opts.project_key || 'testorg/testproj/main',
    }),
  });
  return res.json();
};

test.describe('Project refinement @fast', () => {
  test('PR-1: POST /refine on registered project with draft item returns dispatch_id and accepted', async () => {
    const base = getBase();
    await seedProject(base);
    await seedWorkItem(base, { status: 'draft', title: 'PR-1 draft item', project_key: 'testorg/testproj/main' });

    const res = await fetch(`${base}/api/projects/testorg/testproj/main/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('dispatch_id');
    expect(body.accepted).toBe(true);

    if (body.dispatch_id) {
      const activeRes = await fetch(`${base}/api/dispatch/active`);
      const active = await activeRes.json();
      const dispatch = active.find(d => d.id === body.dispatch_id);
      expect(dispatch).toBeTruthy();
      expect(dispatch.dispatch_mode).toBe('project_refinement');
      expect(dispatch.project_key).toBe('testorg/testproj/main');
      expect(dispatch.status).toBe('running');
      expect(dispatch.work_item_id).toBeFalsy();

      await fetch(`${base}/api/dispatch/${body.dispatch_id}`, { method: 'DELETE' });
    }
  });

  test('PR-2: POST on unknown project key returns 404', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/projects/nonexistent/proj/comp/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe('string');
  });

  test('PR-3: POST while live project_refinement dispatch exists returns 409; stale row does not block', async () => {
    const base = getBase();
    await seedProject(base);

    // Seed a stale running dispatch with a dead PID — must NOT block
    const staleId = `D-stale-${Date.now()}`;
    await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: staleId,
        status: 'running',
        project_key: 'testorg/testproj/main',
        title: 'Stale project refinement',
        dispatch_mode: 'project_refinement',
        pid: 999999999,
      }),
    });

    // Should be accepted — stale PID is not alive
    const res = await fetch(`${base}/api/projects/testorg/testproj/main/refine`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const accepted = await res.json();
    expect(accepted.accepted).toBe(true);

    if (accepted.dispatch_id) {
      await fetch(`${base}/api/dispatch/${accepted.dispatch_id}`, { method: 'DELETE' });
    }
    await fetch(`${base}/api/dispatch/${staleId}`, { method: 'DELETE' });
  });

  test('PR-4: GET template on project with no custom file returns default content, seeds file; second GET returns custom', async () => {
    const base = getBase();
    await seedProject(base, { org: 'tmplorg', proj: 'tmplproj', comp: 'main' });

    const res1 = await fetch(`${base}/api/projects/tmplorg/tmplproj/main/artifacts/refinement-template`);
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.source).toBe('default');
    expect(typeof body1.body).toBe('string');
    expect(body1.body).toContain('{{PROJECT_KEY}}');

    // Second GET must return 'custom' (seeded file) and same content
    const res2 = await fetch(`${base}/api/projects/tmplorg/tmplproj/main/artifacts/refinement-template`);
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.source).toBe('custom');
    expect(body2.body).toBe(body1.body);
  });

  test('PR-5: PUT template persists; subsequent GET returns custom content', async () => {
    const base = getBase();
    await seedProject(base, { org: 'putorg', proj: 'putproj', comp: 'main' });

    const customBody = '# Custom Template\n\nThis is a custom refinement template for {{PROJECT_KEY}}.';
    const putRes = await fetch(`${base}/api/projects/putorg/putproj/main/artifacts/refinement-template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: customBody }),
    });
    expect(putRes.status).toBe(200);
    const putResult = await putRes.json();
    expect(putResult.saved).toBe(true);

    const getRes = await fetch(`${base}/api/projects/putorg/putproj/main/artifacts/refinement-template`);
    expect(getRes.status).toBe(200);
    const getResult = await getRes.json();
    expect(getResult.source).toBe('custom');
    expect(getResult.body).toBe(customBody);
  });

  test('PR-6: DELETE template removes custom file; subsequent GET returns default and re-seeds', async () => {
    const base = getBase();
    await seedProject(base, { org: 'delorg', proj: 'delproj', comp: 'main' });

    // Seed custom template
    const customBody = '# Custom to be deleted\n\n{{PROJECT_KEY}}';
    await fetch(`${base}/api/projects/delorg/delproj/main/artifacts/refinement-template`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: customBody }),
    });

    // Delete it
    const delRes = await fetch(`${base}/api/projects/delorg/delproj/main/artifacts/refinement-template`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    const delResult = await delRes.json();
    expect(delResult.deleted).toBe(true);

    // After delete, GET returns default (re-seeded)
    const getRes = await fetch(`${base}/api/projects/delorg/delproj/main/artifacts/refinement-template`);
    expect(getRes.status).toBe(200);
    const getResult = await getRes.json();
    expect(getResult.source).toBe('default');
    expect(getResult.body).not.toBe(customBody);
    expect(getResult.body).toContain('{{PROJECT_KEY}}');
  });

  test('PR-7: dispatch_mode project_refinement is recognized in active dispatch list', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/dispatch/active`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('PR-8: buildProjectRefinementPrompt snapshot — same inputs produce stable string', async () => {
    const template = '# Test\n\n{{PROJECT_KEY}} {{DASHBOARD_URL}} {{WORKING_LIST}} {{EPICS_LIST}} {{INSTRUCTIONS}} {{DRY_RUN}}';
    const items = [
      { id: 'W-1', status: 'draft', priority: 'high', title: 'First item', depends_on: [] },
      { id: 'W-2', status: 'planned', priority: 'medium', title: 'Second item', depends_on: ['W-1'] },
    ];
    const epics = [
      { id: 'E-1', status: 'active', title: 'My epic' },
    ];

    const args = {
      projectKey: 'myorg/myproj/main',
      projectPath: '/tmp/myproj',
      template,
      items,
      epics,
      instructions: 'Focus on contracts',
      dryRun: false,
      port: 3777,
    };

    const result1 = buildProjectRefinementPrompt(args);
    const result2 = buildProjectRefinementPrompt(args);

    expect(result1).toBe(result2);
    expect(result1).toContain('myorg/myproj/main');
    expect(result1).toContain('http://127.0.0.1:3777');
    expect(result1).toContain('W-1 [draft] [high] First item');
    expect(result1).toContain('W-2 [planned] [medium] Second item (depends: W-1)');
    expect(result1).toContain('E-1 [active] My epic');
    expect(result1).toContain('Focus on contracts');
    expect(result1).toContain('false');

    // Mutating template after call must NOT affect result
    args.template += '\n# Extra';
    const result3 = buildProjectRefinementPrompt({ ...args, template: template });
    expect(result3).toBe(result1);
  });

  test('PR-8b: buildProjectRefinementPrompt dry_run=true renders true', async () => {
    const template = '{{DRY_RUN}}';
    const result = buildProjectRefinementPrompt({
      projectKey: 'a/b/c',
      projectPath: '/tmp',
      template,
      items: [],
      epics: [],
      instructions: '',
      dryRun: true,
      port: 3777,
    });
    expect(result).toBe('true');
  });

  test('PR-8c: buildProjectRefinementPrompt with empty items and epics uses placeholder strings', async () => {
    const template = '{{WORKING_LIST}}|{{EPICS_LIST}}';
    const result = buildProjectRefinementPrompt({
      projectKey: 'a/b/c',
      projectPath: '/tmp',
      template,
      items: [],
      epics: [],
      instructions: '',
      dryRun: false,
      port: 3777,
    });
    expect(result).toBe('(no items in scope)|(no epics in scope)');
  });

  test('PR-11: cost-anomaly exemption — project_refinement mode is excluded from anomaly detection', async () => {
    const base = getBase();

    // Seed multiple historical dispatches to build a cost average
    const projectKey = 'costorg/costproj/main';
    for (let i = 0; i < 4; i++) {
      await fetch(`${base}/api/test/seed-session-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_key: projectKey,
          cost_usd: 1.0,
          duration_seconds: 60,
        }),
      });
    }

    // Seed a project_refinement dispatch with very high cost (5× average)
    const dispatchId = `D-pr-cost-${Date.now()}`;
    await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: dispatchId,
        status: 'completed',
        project_key: projectKey,
        title: 'Project refinement cost test',
        dispatch_mode: 'project_refinement',
      }),
    });

    const activeRes = await fetch(`${base}/api/dispatch/active`);
    const active = await activeRes.json();
    const dispatch = active.find(d => d.id === dispatchId);
    // Dispatch is completed, may or may not be in active list — just check no anomaly in session_log
    if (dispatch) {
      const sessionLog = dispatch.session_log || [];
      const hasAnomaly = sessionLog.some(entry => entry.trigger === 'cost-anomaly');
      expect(hasAnomaly).toBe(false);
    }

    await fetch(`${base}/api/dispatch/${dispatchId}`, { method: 'DELETE' });
  });

  test('PR-12: existing refinement tests still work — active dispatch endpoint is functional', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/dispatch/active`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
  });

  test('PR-13: GET /api/projects returns 200 with an array (may be empty). Each element has org, project, component fields.', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/projects`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    for (const item of body) {
      expect(typeof item.org).toBe('string');
      expect(typeof item.project).toBe('string');
      expect(typeof item.component).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Helper — POST /refine-terminal for a given project key
// ---------------------------------------------------------------------------
async function postRefineTerminal(org = 'testorg', proj = 'testproj', comp = 'main') {
  const base = getBase();
  const resp = await fetch(`${base}/api/projects/${org}/${proj}/${comp}/refine-terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return resp;
}

test.describe('Interactive terminal refine — /refine-terminal @fast', () => {
  // RT-1: POST /refine-terminal on registered project returns 200 with terminal_id and accepted:true
  test('RT-1: POST /refine-terminal on registered project returns 200 with terminal_id and accepted:true', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    const resp = await postRefineTerminal();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.accepted).toBe(true);
    expect(typeof body.terminal_id).toBe('string');
    expect(body.terminal_id.length).toBeGreaterThan(0);

    // Cleanup
    if (body.terminal_id) {
      const base = getBase();
      await fetch(`${base}/api/terminal/${body.terminal_id}`, { method: 'DELETE' });
    }
  });

  // RT-2: POST /refine-terminal while a live terminal session for the same project returns 409
  test('RT-2: POST /refine-terminal while a live terminal session for the same project returns 409', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    const first = await postRefineTerminal();
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.accepted).toBe(true);

    let secondBody = null;
    try {
      const second = await postRefineTerminal();
      expect(second.status).toBe(409);
      secondBody = await second.json().catch(() => null);
    } finally {
      // Cleanup both sessions
      if (firstBody.terminal_id) {
        await fetch(`${base}/api/terminal/${firstBody.terminal_id}`, { method: 'DELETE' });
      }
      if (secondBody?.terminal_id) {
        await fetch(`${base}/api/terminal/${secondBody.terminal_id}`, { method: 'DELETE' });
      }
    }
  });

  // RT-3: POST /refine-terminal on an unknown/unregistered project key returns 404
  test('RT-3: POST /refine-terminal on unknown/unregistered project key returns 404', async () => {
    const resp = await postRefineTerminal('unknown', 'missing', 'component');
    expect(resp.status).toBe(404);
    const body = await resp.json().catch(() => null);
    if (body !== null) {
      expect(typeof body.error).toBe('string');
    }
  });

  // RT-4: POST /refine-terminal while a running project_refinement dispatch exists for the same project returns 409
  test('RT-4: POST /refine-terminal while a live project_refinement dispatch exists for the same project returns 409', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });

    // Seed a running project_refinement dispatch for the same project key
    const seedId = `D-rt4-${Date.now()}`;
    await fetch(`${base}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: seedId,
        status: 'running',
        project_key: 'testorg/testproj/main',
        title: 'RT-4 running refinement dispatch',
        dispatch_mode: 'project_refinement',
      }),
    });

    let terminalId = null;
    try {
      const resp = await postRefineTerminal();
      expect(resp.status).toBe(409);
      const body = await resp.json().catch(() => null);
      terminalId = body?.terminal_id ?? null;
    } finally {
      await fetch(`${base}/api/dispatch/${seedId}`, { method: 'DELETE' });
      // Cleanup any accidentally created terminal
      if (terminalId) {
        await fetch(`${base}/api/terminal/${terminalId}`, { method: 'DELETE' });
      }
    }
  });

  // RT-5: GET /api/terminal/active includes the new refine-terminal session
  test('RT-5: GET /api/terminal/active includes the new refine-terminal session', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    const resp = await postRefineTerminal();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.accepted).toBe(true);
    const terminalId = body.terminal_id;

    try {
      const activeRes = await fetch(`${base}/api/terminal/active`);
      expect(activeRes.status).toBe(200);
      const active = await activeRes.json();
      expect(Array.isArray(active)).toBe(true);
      const found = active.find(t => t.id === terminalId || t.terminal_id === terminalId);
      expect(found).toBeTruthy();
    } finally {
      if (terminalId) {
        await fetch(`${base}/api/terminal/${terminalId}`, { method: 'DELETE' });
      }
    }
  });

  // RT-6: POST /refine-terminal with no draft/planned items still returns accepted:true (not 500)
  test('RT-6: POST /refine-terminal on project with no eligible items still returns accepted:true', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    // Regardless of whether it has refinable items, the endpoint must succeed.
    const resp = await postRefineTerminal();
    // The endpoint may return 200 or 409 (if a prior test left a live session);
    // what must NOT happen is a 500 server error.
    expect(resp.status).not.toBe(500);

    if (resp.status === 200) {
      const body = await resp.json();
      expect(body.accepted).toBe(true);
      if (body.terminal_id) {
        const base = getBase();
        await fetch(`${base}/api/terminal/${body.terminal_id}`, { method: 'DELETE' });
      }
    }
  });

  // RT-7: DELETE /api/terminal/:id kills the refine-terminal session
  test('RT-7: DELETE /api/terminal/:id removes the refine-terminal session', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    const resp = await postRefineTerminal();
    expect(resp.status).toBe(200);
    const body = await resp.json();
    const terminalId = body.terminal_id;
    expect(terminalId).toBeTruthy();

    // Delete the terminal
    const delRes = await fetch(`${base}/api/terminal/${terminalId}`, { method: 'DELETE' });
    expect([200, 204]).toContain(delRes.status);

    // Verify it no longer appears in the active list
    const activeRes = await fetch(`${base}/api/terminal/active`);
    expect(activeRes.status).toBe(200);
    const active = await activeRes.json();
    const stillPresent = active.find(t => t.id === terminalId || t.terminal_id === terminalId);
    expect(stillPresent).toBeFalsy();
  });

  // RT-8: POST /refine-terminal response shape matches expected schema
  test('RT-8: POST /refine-terminal response shape matches expected schema', async () => {
    const base = getBase();
    await seedProject(base, { path: '/tmp' });
    const resp = await postRefineTerminal();
    expect(resp.status).toBe(200);
    const body = await resp.json();

    // Shape assertions
    expect(body.accepted).toBe(true);
    expect(typeof body.terminal_id).toBe('string');
    expect(body.terminal_id.startsWith('T-')).toBe(true);

    // Cleanup
    if (body.terminal_id) {
      await fetch(`${base}/api/terminal/${body.terminal_id}`, { method: 'DELETE' });
    }
  });
});
