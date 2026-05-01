export default function adrsRoutes(deps) {
  const { json, err, db: dbModule, parseBody } = deps;

  return [
    [/^\/api\/adrs$/, 'GET', async (_m, req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const org = url.searchParams.get('org') ?? 'neuronic';
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const rows = await dbModule.getAdrs(org, limit);
      json(res, rows);
    }],

    [/^\/api\/adrs\/([^/]+)$/, 'GET', async (m, _req, res) => {
      const id = decodeURIComponent(m[1]);
      const row = await dbModule.getAdr(id);
      if (!row) return err(res, 'not found', 404);
      json(res, row);
    }],

    [/^\/api\/adrs$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const required = ['id', 'org_key', 'title', 'type', 'detail_path'];
      const missing = required.filter(f => !body[f]);
      if (missing.length) return err(res, `missing required fields: ${missing.join(', ')}`, 400);
      await dbModule.createAdr(body);
      json(res, { ok: true });
    }],
  ];
}
