import { validateModel } from '../utils.mjs';

export default function sessionRoutes(deps) {
  const { db, json, err, parseBody, isPidAlive, cliSessions, saveCliSessionToDb, archiveSession } = deps;
  return [
    // --- Aggregate history endpoint ---

    // All sessions history (last 100, newest first)
    [/^\/api\/sessions\/all$/, 'GET', async (_m, _req, res) => {
      const rows = await db.getSessionHistory({ limit: 100 });
      json(res, rows);
    }],

    // --- CLI session endpoints ---

    // Register CLI session
    [/^\/api\/sessions\/register$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { project_key, title, pid, work_item_id, epic_id, claude_session_id: rawClaudeSessionId, model: rawModel } = body;
      if (!project_key || !title || !pid) {
        return err(res, 'project_key, title, and pid are required', 400);
      }
      if (!isPidAlive(pid)) {
        return err(res, 'PID is not alive', 400);
      }
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (rawClaudeSessionId != null && !UUID_RE.test(rawClaudeSessionId)) {
        return err(res, 'claude_session_id must be a valid UUID', 400);
      }
      const claude_session_id = rawClaudeSessionId ?? null;
      const model = validateModel(rawModel) ?? null;
      const id = `C-${Date.now()}`;
      const session = {
        id,
        project_key,
        work_item_id: work_item_id || null,
        epic_id: epic_id || null,
        title,
        pid,
        status: 'running',
        registered_at: new Date().toISOString(),
        exited_at: null,
        claude_session_id,
        model,
      };
      cliSessions.set(id, session);
      await saveCliSessionToDb(session);
      json(res, { id, status: session.status, registered_at: session.registered_at }, 201);
    }],

    // List CLI sessions
    [/^\/api\/sessions\/active$/, 'GET', async (_m, req, res) => {
      const projectKey = new URL(req.url, 'http://x').searchParams.get('project_key') || null;
      const list = [];
      for (const [, c] of cliSessions) {
        if (!projectKey || c.project_key === projectKey) list.push({ ...c });
      }
      json(res, list);
    }],

    // Deregister CLI session
    [/^\/api\/sessions\/(C-[A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
      const session = cliSessions.get(m[1]);
      if (!session) return err(res, 'CLI session not found', 404);
      session.status = 'exited';
      session.exited_at = new Date().toISOString();
      await saveCliSessionToDb(session);
      await archiveSession(session, 'cli');
      cliSessions.delete(m[1]);
      json(res, { status: 'exited', id: m[1] });
    }],
  ];
}
