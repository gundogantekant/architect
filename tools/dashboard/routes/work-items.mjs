export default function workItemRoutes(deps) {
  const { db, json, err, parseBody, readFile, writeFile, readdir, unlinkFile, mkdir, join, WORK, VALID_WORK_ITEM_STATUSES, VALID_PRIORITIES, text } = deps;
  return [
    // Backlog
    [/^\/api\/backlog$/, 'GET', async (_m, req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost');
      const orgFilter = reqUrl.searchParams.get('org');
      json(res, db.getBacklog(orgFilter || null));
    }],

    // Next available IDs (peek without incrementing)
    [/^\/api\/sequences\/next$/, 'GET', async (_m, _req, res) => {
      json(res, db.peekNextIds());
    }],

    // --- Work item endpoints ---

    // Get single work item
    [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'GET', async (m, _req, res) => {
      const item = db.getWorkItemFull(m[1]);
      if (!item) return err(res, 'work item not found', 404);
      json(res, item);
    }],

    // Create work item
    [/^\/api\/work-items$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { project_key, title, status, priority, description, tags, epic_id } = body;
      if (!project_key || !title) {
        return err(res, 'project_key and title are required', 400);
      }
      if (status && !VALID_WORK_ITEM_STATUSES.has(status)) {
        return err(res, `invalid status '${status}', must be one of: ${[...VALID_WORK_ITEM_STATUSES].join(', ')}`, 400);
      }
      if (priority && !VALID_PRIORITIES.has(priority)) {
        return err(res, `invalid priority '${priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
      }
      const item = db.createWorkItem({ project_key, title, status, priority, description, tags, epic_id });
      json(res, item, 201);
    }],

    // Update work item
    [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'PATCH', async (m, req, res) => {
      const itemId = m[1];
      const existing = db.getWorkItem(itemId);
      if (!existing) return err(res, 'work item not found', 404);
      const body = await parseBody(req);
      if (body.status && !VALID_WORK_ITEM_STATUSES.has(body.status)) {
        return err(res, `invalid status '${body.status}', must be one of: ${[...VALID_WORK_ITEM_STATUSES].join(', ')}`, 400);
      }
      if (body.priority && !VALID_PRIORITIES.has(body.priority)) {
        return err(res, `invalid priority '${body.priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
      }
      const updated = db.updateWorkItem(itemId, body);
      json(res, updated);
    }],

    // Delete work item
    [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
      const deleted = db.deleteWorkItem(m[1]);
      if (!deleted) return err(res, 'work item not found', 404);
      json(res, { deleted: m[1] });
    }],

    // Add session log entry to work item
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

    // Add dependencies to work item
    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'POST', async (m, req, res) => {
      const itemId = m[1];
      const body = await parseBody(req);
      const { targets } = body;
      if (!targets || !targets.length) return err(res, 'targets array is required', 400);

      const added = [];
      for (const tid of targets) {
        try {
          db.addDependency(itemId, tid);
          added.push(tid);
        } catch (e) {
          return err(res, e.message, 400);
        }
      }
      if (added.length) db.addWorkItemLog(itemId, `Added dependencies: ${added.join(', ')}`);
      json(res, db.getWorkItemFull(itemId));
    }],

    // Remove dependencies from work item
    [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'DELETE', async (m, req, res) => {
      const itemId = m[1];
      const body = await parseBody(req);
      const { targets } = body;
      if (!targets || !targets.length) return err(res, 'targets array is required', 400);

      const existing = db.getWorkItem(itemId);
      if (!existing) return err(res, 'work item not found', 404);

      const removed = targets.filter(t => existing.depends_on.includes(t));
      for (const tid of removed) {
        db.removeDependency(itemId, tid);
      }
      if (removed.length) db.addWorkItemLog(itemId, `Removed dependencies: ${removed.join(', ')}`);
      json(res, db.getWorkItemFull(itemId));
    }],

    // Read work item plan
    [/^\/api\/work-items\/(W-\d+)\/plan$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'items', m[1], 'plan.md'), 'utf8');
        text(res, content);
      } catch {
        text(res, '', 'text/plain', 200);
      }
    }],

    // Write work item plan
    [/^\/api\/work-items\/(W-\d+)\/plan$/, 'PUT', async (m, req, res) => {
      const body = await parseBody(req);
      const dir = join(WORK, 'items', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plan.md'), body.content || '');
      json(res, { saved: true });
    }],

    // Read work item doc
    [/^\/api\/work-items\/(W-\d+)\/doc$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'items', m[1], 'docs.md'), 'utf8');
        text(res, content);
      } catch {
        text(res, '', 'text/plain', 200);
      }
    }],

    // Write work item doc
    [/^\/api\/work-items\/(W-\d+)\/doc$/, 'PUT', async (m, req, res) => {
      const body = await parseBody(req);
      const dir = join(WORK, 'items', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'docs.md'), body.content || '');
      json(res, { saved: true });
    }],

    // List work item artifacts
    [/^\/api\/work-items\/(W-\d+)\/artifacts$/, 'GET', async (m, _req, res) => {
      try {
        const files = await readdir(join(WORK, 'items', m[1]));
        json(res, { files });
      } catch {
        json(res, { files: [] });
      }
    }],

    // Read a specific artifact file
    [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'items', m[1], m[2]), 'utf8');
        text(res, content);
      } catch {
        err(res, 'artifact not found', 404);
      }
    }],

    // Write a specific artifact file
    [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'PUT', async (m, req, res) => {
      const body = await parseBody(req);
      const dir = join(WORK, 'items', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, m[2]), body.content || '');
      json(res, { saved: true });
    }],

    // Delete a specific artifact file
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
