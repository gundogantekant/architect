import { validateDocContent } from './work-items.mjs';

export default function epicRoutes(deps) {
  const { db, json, text, err, parseBody, readFile, writeFile, mkdir, join, WORK, VALID_EPIC_STATUSES, VALID_PRIORITIES } = deps;
  return [
    // --- Epic endpoints ---

    // List epics
    [/^\/api\/epics$/, 'GET', async (_m, _req, res) => {
      const epicList = await db.listEpics();
      const epics = await Promise.all(epicList.map(async epic => {
        const items = await db.getWorkItemsByEpic(epic.id);
        const done = items.filter(i => i.status === 'done').length;
        return {
          ...epic,
          work_item_ids: items.map(i => i.id),
          project_keys: await db.getEpicProjectKeys(epic.id),
          session_log: (await db.getEpicLogs(epic.id)).map(l => ({ date: l.logged_at, summary: l.summary })),
          progress: { done, total: items.length },
        };
      }));
      json(res, epics);
    }],

    // Get epic detail
    [/^\/api\/epics\/(E-\d+)$/, 'GET', async (m, _req, res) => {
      const epic = await db.getEpicFull(m[1]);
      if (!epic) return err(res, 'epic not found', 404);
      json(res, epic);
    }],

    // Create epic
    [/^\/api\/epics$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { title, status, priority, description, acceptance_criteria, target_date, tags } = body;
      if (!title) return err(res, 'title is required', 400);
      if (status && !VALID_EPIC_STATUSES.has(status)) {
        return err(res, `invalid status '${status}', must be one of: ${[...VALID_EPIC_STATUSES].join(', ')}`, 400);
      }
      if (priority && !VALID_PRIORITIES.has(priority)) {
        return err(res, `invalid priority '${priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
      }
      const epic = await db.createEpic({ title, status, priority, description, acceptance_criteria, target_date, tags });
      // Return with derived fields
      epic.work_item_ids = [];
      epic.project_keys = [];
      epic.session_log = (await db.getEpicLogs(epic.id)).map(l => ({ date: l.logged_at, summary: l.summary }));
      json(res, epic, 201);
    }],

    // Update epic
    [/^\/api\/epics\/(E-\d+)$/, 'PATCH', async (m, req, res) => {
      const existing = await db.getEpic(m[1]);
      if (!existing) return err(res, 'epic not found', 404);
      const body = await parseBody(req);
      if (body.status && !VALID_EPIC_STATUSES.has(body.status)) {
        return err(res, `invalid status '${body.status}', must be one of: ${[...VALID_EPIC_STATUSES].join(', ')}`, 400);
      }
      if (body.priority && !VALID_PRIORITIES.has(body.priority)) {
        return err(res, `invalid priority '${body.priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
      }
      const updated = await db.updateEpic(m[1], body);
      updated.work_item_ids = await db.getEpicWorkItemIds(m[1]);
      updated.project_keys = await db.getEpicProjectKeys(m[1]);
      updated.session_log = (await db.getEpicLogs(m[1])).map(l => ({ date: l.logged_at, summary: l.summary }));
      json(res, updated);
    }],

    // Delete epic
    [/^\/api\/epics\/(E-\d+)$/, 'DELETE', async (m, _req, res) => {
      const archived = await db.deleteEpic(m[1]);
      if (!archived) return err(res, 'epic not found', 404);
      json(res, { archived: m[1], status: 'cancelled' });
    }],

    // Archive epic (non-destructive — preserves links)
    [/^\/api\/epics\/(E-\d+)\/archive$/, 'POST', async (m, _req, res) => {
      const result = await db.archiveEpic(m[1]);
      if (!result) {
        const epic = await db.getEpic(m[1]);
        if (!epic) return err(res, 'epic not found', 404);
        return err(res, 'only done or cancelled epics can be archived', 400);
      }
      json(res, result);
    }],

    // Link work items to epic
    [/^\/api\/epics\/(E-\d+)\/link$/, 'POST', async (m, req, res) => {
      const body = await parseBody(req);
      const { work_item_ids } = body;
      if (!work_item_ids || !work_item_ids.length) return err(res, 'work_item_ids required', 400);
      try {
        const linked = await db.linkItemsToEpic(m[1], work_item_ids);
        json(res, { linked, epic_id: m[1] });
      } catch (e) {
        return err(res, e.message, 404);
      }
    }],

    // Unlink work item from epic
    [/^\/api\/epics\/(E-\d+)\/unlink$/, 'POST', async (m, req, res) => {
      const body = await parseBody(req);
      const { work_item_id } = body;
      if (!work_item_id) return err(res, 'work_item_id required', 400);
      const existing = await db.getEpic(m[1]);
      if (!existing) return err(res, 'epic not found', 404);
      await db.unlinkItemFromEpic(m[1], work_item_id);
      json(res, { unlinked: work_item_id, epic_id: m[1] });
    }],

    // Read epic plan
    [/^\/api\/epics\/(E-\d+)\/plan$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'epics', m[1], 'plan.md'), 'utf8');
        text(res, content);
      } catch {
        text(res, '', 'text/plain', 200);
      }
    }],

    // Write epic plan
    [/^\/api\/epics\/(E-\d+)\/plan$/, 'PUT', async (m, req, res) => {
      let body;
      try {
        body = await parseBody(req);
      } catch {
        return err(res, 'invalid JSON body', 400);
      }
      try {
        validateDocContent(body.content);
      } catch (e) {
        return err(res, e.message, e.status ?? 422);
      }
      const dir = join(WORK, 'epics', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plan.md'), body.content || '');
      json(res, { saved: true });
    }],

    // Read epic doc
    [/^\/api\/epics\/(E-\d+)\/doc$/, 'GET', async (m, _req, res) => {
      try {
        const content = await readFile(join(WORK, 'epics', m[1], 'docs.md'), 'utf8');
        text(res, content);
      } catch {
        text(res, '', 'text/plain', 200);
      }
    }],

    // Write epic doc
    [/^\/api\/epics\/(E-\d+)\/doc$/, 'PUT', async (m, req, res) => {
      let body;
      try {
        body = await parseBody(req);
      } catch {
        return err(res, 'invalid JSON body', 400);
      }
      try {
        validateDocContent(body.content);
      } catch (e) {
        return err(res, e.message, e.status ?? 422);
      }
      const dir = join(WORK, 'epics', m[1]);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'docs.md'), body.content || '');
      json(res, { saved: true });
    }],
  ];
}
