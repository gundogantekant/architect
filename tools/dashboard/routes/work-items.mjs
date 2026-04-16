import {
  VALID_TRANSITIONS,
  BACKWARD_TRANSITIONS,
  STAKEHOLDER_PROJECTION,
  VALID_APPROVAL_MODES,
  T1_FAST_PATH_TRANSITIONS,
  formatStatusWithFlags,
  isBackwardTransition,
  isAdministrativeTransition,
} from '../constants.mjs';

function projectBacklog(backlog, view) {
  if (view !== 'stakeholder') return backlog;
  const projects = {};
  for (const [key, group] of Object.entries(backlog.projects || {})) {
    projects[key] = {
      ...group,
      items: (group.items || []).map(item => ({ ...item, status: formatStatusWithFlags(item, 'stakeholder') })),
    };
  }
  return { ...backlog, projects };
}

function itemMatchesAwaitingAction(item) {
  return item.input_needed || (item.approval && item.approval.active) || item.status === 'blocked';
}

function filterAwaitingAction(backlog) {
  const projects = {};
  for (const [key, group] of Object.entries(backlog.projects || {})) {
    const items = (group.items || []).filter(itemMatchesAwaitingAction);
    if (items.length > 0) projects[key] = { ...group, items };
  }
  return { ...backlog, projects };
}

function validateTransition(fromStatus, toStatus, item, body) {
  if (fromStatus === toStatus) return { ok: true };

  const validTargets = [...(VALID_TRANSITIONS.get(fromStatus) || new Set())];
  const isT1 = Array.isArray(item.tags) && item.tags.includes('T1');
  const t1Allowed = isT1 && T1_FAST_PATH_TRANSITIONS.has(`${fromStatus}->${toStatus}`);

  if (!validTargets.includes(toStatus) && !t1Allowed) {
    return {
      ok: false,
      code: 400,
      body: {
        error: `invalid transition ${fromStatus}\u2192${toStatus}`,
        from: fromStatus,
        attempted: toStatus,
        valid_targets: validTargets,
      },
    };
  }

  const isAdmin = isAdministrativeTransition(fromStatus, toStatus);
  const flagActive = item.input_needed || (item.approval && item.approval.active);
  if (flagActive && !isAdmin && !t1Allowed) {
    return {
      ok: false,
      code: 400,
      body: {
        error: `forward transition blocked by active flag`,
        from: fromStatus,
        attempted: toStatus,
        input_needed: !!item.input_needed,
        approval_active: !!(item.approval && item.approval.active),
      },
    };
  }

  if (fromStatus === 'planned' && toStatus === 'draft' && !body.reason) {
    return { ok: false, code: 400, body: { error: 'planned\u2192draft requires reason' } };
  }

  return { ok: true };
}

export default function workItemRoutes(deps) {
  const { db, json, err, parseBody, readFile, writeFile, readdir, unlinkFile, mkdir, join, WORK, VALID_WORK_ITEM_STATUSES, VALID_PRIORITIES, text } = deps;
  return [
    [/^\/api\/backlog$/, 'GET', async (_m, req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost');
      const orgFilter = reqUrl.searchParams.get('org');
      const view = reqUrl.searchParams.get('view');
      const awaitingAction = reqUrl.searchParams.get('awaiting_action') === 'true';
      let backlog = db.getBacklog(orgFilter || null);
      if (awaitingAction) backlog = filterAwaitingAction(backlog);
      backlog = projectBacklog(backlog, view);
      json(res, backlog);
    }],

    [/^\/api\/sequences\/next$/, 'GET', async (_m, _req, res) => {
      json(res, db.peekNextIds());
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'GET', async (m, _req, res) => {
      const item = db.getWorkItemFull(m[1]);
      if (!item) return err(res, 'work item not found', 404);
      json(res, item);
    }],

    [/^\/api\/work-items$/, 'GET', async (_m, req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost');
      const approverPending = reqUrl.searchParams.get('approver_pending');
      if (approverPending) {
        const rows = db.getPendingApprovalsForIdentity(approverPending);
        const itemIds = [...new Set(rows.map(r => r.work_item_id))];
        const items = itemIds.map(id => db.getWorkItemFull(id)).filter(Boolean);
        return json(res, items);
      }
      json(res, db.getAllWorkItems());
    }],

    [/^\/api\/work-items$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { project_key, title, status, priority, description, tags, epic_id } = body;
      if (!project_key || !title) return err(res, 'project_key and title are required', 400);
      if (status && !VALID_WORK_ITEM_STATUSES.has(status)) {
        return err(res, `invalid status '${status}', must be one of: ${[...VALID_WORK_ITEM_STATUSES].join(', ')}`, 400);
      }
      if (priority && !VALID_PRIORITIES.has(priority)) {
        return err(res, `invalid priority '${priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
      }
      const item = db.createWorkItem({ project_key, title, status, priority, description, tags, epic_id });
      json(res, item, 201);
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'PATCH', async (m, req, res) => {
      const itemId = m[1];
      const existing = db.getWorkItem(itemId);
      if (!existing) return err(res, 'work item not found', 404);
      const body = await parseBody(req);

      if (body.status !== undefined) {
        if (!VALID_WORK_ITEM_STATUSES.has(body.status)) {
          return err(res, `invalid status '${body.status}', must be one of: ${[...VALID_WORK_ITEM_STATUSES].join(', ')}`, 400);
        }
        const validation = validateTransition(existing.status, body.status, existing, body);
        if (!validation.ok) {
          res.statusCode = validation.code;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(validation.body));
          return;
        }
      }
      if (body.priority && !VALID_PRIORITIES.has(body.priority)) {
        return err(res, `invalid priority '${body.priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
      }
      if (body.approval_mode !== undefined && !VALID_APPROVAL_MODES.has(body.approval_mode)) {
        return err(res, `invalid approval_mode '${body.approval_mode}'`, 400);
      }

      const prevStatus = existing.status;
      try {
        const updated = db.updateWorkItem(itemId, body);

        if (body.status && body.status !== prevStatus) {
          let summary = `Status: ${prevStatus} → ${body.status}`;
          if (prevStatus === 'planned' && body.status === 'draft' && body.reason) {
            summary += ` (reason: ${body.reason})`;
          }
          db.addWorkItemLog(itemId, summary);
          if (body.status === 'done' && db.resolveBlockedApprovals) db.resolveBlockedApprovals(itemId);
        }
        json(res, db.getWorkItemFull(itemId));
      } catch (e) {
        return err(res, e.message, 400);
      }
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
      const deleted = db.deleteWorkItem(m[1]);
      if (!deleted) return err(res, 'work item not found', 404);
      json(res, { deleted: m[1] });
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/log$/, 'POST', async (m, req, res) => {
      const itemId = m[1];
      const body = await parseBody(req);
      const { message, summary } = body;
      const logMsg = message || summary;
      if (!logMsg) return err(res, 'message is required', 400);
      const existing = db.getWorkItem(itemId);
      if (!existing) return err(res, 'work item not found', 404);
      db.addWorkItemLog(itemId, logMsg);
      json(res, db.getWorkItemFull(itemId));
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/input-needed$/, 'PATCH', async (m, req, res) => {
      const itemId = m[1];
      const existing = db.getWorkItem(itemId);
      if (!existing) return err(res, 'work item not found', 404);
      const body = await parseBody(req);
      const patch = { input_needed: !!body.active };
      if (body.active) {
        patch.input_needed_from = body.from || '';
        patch.input_needed_reason = body.reason || '';
        patch.input_needed_at = new Date().toISOString();
      } else {
        patch.input_needed_from = null;
        patch.input_needed_reason = null;
        patch.input_needed_at = null;
      }
      const updated = db.updateWorkItem(itemId, patch);
      db.addWorkItemLog(itemId, body.active ? `Input needed from ${body.from || 'unspecified'}` : 'Input flag cleared');
      json(res, db.getWorkItemFull(itemId));
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/released$/, 'PATCH', async (m, req, res) => {
      const itemId = m[1];
      const existing = db.getWorkItem(itemId);
      if (!existing) return err(res, 'work item not found', 404);
      if (existing.status !== 'done') {
        return err(res, `released metadata only settable when status=done (current: ${existing.status})`, 400);
      }
      const body = await parseBody(req);
      const patch = {
        released_at: body.released_at || new Date().toISOString(),
        released_version: body.released_version || '',
      };
      db.updateWorkItem(itemId, patch);
      db.addWorkItemLog(itemId, `Released ${patch.released_version || '(no version)'}`);
      json(res, db.getWorkItemFull(itemId));
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'POST', async (m, req, res) => {
      const itemId = m[1];
      const body = await parseBody(req);
      const { targets } = body;
      if (!targets || !targets.length) return err(res, 'targets array is required', 400);
      const added = [];
      for (const tid of targets) {
        try { db.addDependency(itemId, tid); added.push(tid); }
        catch (e) { return err(res, e.message, 400); }
      }
      if (added.length) db.addWorkItemLog(itemId, `Added dependencies: ${added.join(', ')}`);
      json(res, db.getWorkItemFull(itemId));
    }],

    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'DELETE', async (m, req, res) => {
      const itemId = m[1];
      const body = await parseBody(req);
      const { targets } = body;
      if (!targets || !targets.length) return err(res, 'targets array is required', 400);
      const existing = db.getWorkItem(itemId);
      if (!existing) return err(res, 'work item not found', 404);
      const removed = targets.filter(t => existing.depends_on.includes(t));
      for (const tid of removed) db.removeDependency(itemId, tid);
      if (removed.length) db.addWorkItemLog(itemId, `Removed dependencies: ${removed.join(', ')}`);
      json(res, db.getWorkItemFull(itemId));
    }],

    [/^\/api\/work-items\/(W-\d+)\/plan$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'items', m[1], 'plan.md'), 'utf8');
        text(res, content);
      } catch {
        text(res, '', 'text/plain', 200);
      }
    }],

    [/^\/api\/work-items\/(W-\d+)\/plan$/, 'PUT', async (m, req, res) => {
      const body = await parseBody(req);
      const dir = join(WORK, 'items', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plan.md'), body.content || '');
      json(res, { saved: true });
    }],

    [/^\/api\/work-items\/(W-\d+)\/doc$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'items', m[1], 'docs.md'), 'utf8');
        text(res, content);
      } catch {
        text(res, '', 'text/plain', 200);
      }
    }],

    [/^\/api\/work-items\/(W-\d+)\/doc$/, 'PUT', async (m, req, res) => {
      const body = await parseBody(req);
      const dir = join(WORK, 'items', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'docs.md'), body.content || '');
      json(res, { saved: true });
    }],

    [/^\/api\/work-items\/(W-\d+)\/artifacts$/, 'GET', async (m, _req, res) => {
      try {
        const files = await readdir(join(WORK, 'items', m[1]));
        json(res, { files });
      } catch {
        json(res, { files: [] });
      }
    }],

    [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'items', m[1], m[2]), 'utf8');
        text(res, content);
      } catch {
        err(res, 'artifact not found', 404);
      }
    }],

    [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'PUT', async (m, req, res) => {
      const body = await parseBody(req);
      const dir = join(WORK, 'items', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, m[2]), body.content || '');
      json(res, { saved: true });
    }],

    [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'DELETE', async (m, _req, res) => {
      try {
        await unlinkFile(join(WORK, 'items', m[1], m[2]));
        json(res, { deleted: m[2] });
      } catch {
        err(res, 'artifact not found', 404);
      }
    }],
  ];
}
