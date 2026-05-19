export default function costsRoutes({ db, json, err }) {
  return [
    [/^\/api\/costs\/summary$/, 'GET', async (_m, req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const from = url.searchParams.get('from') || undefined;
      const to = url.searchParams.get('to') || undefined;
      const groupBy = url.searchParams.get('group_by') || 'model';
      const allowed = ['model', 'agent_role', 'project_key', 'epic_id'];
      if (!allowed.includes(groupBy)) {
        return err(res, `group_by must be one of: ${allowed.join(', ')}`, 400);
      }
      const data = await db.getCostSummary({ from, to, groupBy });
      json(res, data);
    }],
    [/^\/api\/costs\/work-item\/([^/]+)$/, 'GET', async (m, _req, res) => {
      const data = await db.getCostByWorkItem(m[1]);
      json(res, data);
    }],
    [/^\/api\/costs\/project\/(.+)$/, 'GET', async (m, _req, res) => {
      const data = await db.getCostByProject(decodeURIComponent(m[1]));
      json(res, data);
    }],
    [/^\/api\/costs\/epic\/([^/]+)$/, 'GET', async (m, _req, res) => {
      const data = await db.getCostByEpic(m[1]);
      json(res, data);
    }],
  ];
}
