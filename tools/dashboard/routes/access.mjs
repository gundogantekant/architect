export default function accessRoutes(deps) {
  const { db, json, err, parseBody, blocklist } = deps;
  return [
    [/^\/api\/access\/requesters$/, 'GET', async (_m, _req, res) => {
      json(res, await db.getAccessLogRequesters());
    }],

    [/^\/api\/access\/blocklist$/, 'GET', async (_m, _req, res) => {
      json(res, await blocklist.getAll(db.getPool()));
    }],

    [/^\/api\/access\/block$/, 'POST', async (_m, req, res) => {
      try {
        const { ip, reason } = await parseBody(req);
        if (!ip) return err(res, 'ip is required', 400);
        await blocklist.block(db.getPool(), ip, reason ?? '');
        json(res, { ok: true });
      } catch (e) {
        err(res, e.message, e.message.includes('loopback') ? 400 : 500);
      }
    }],

    [/^\/api\/access\/block\/(.+)$/, 'DELETE', async (m, _req, res) => {
      try {
        const ip = decodeURIComponent(m[1]);
        await blocklist.unblock(db.getPool(), ip);
        json(res, { ok: true });
      } catch (e) {
        err(res, e.message, e.message.includes('loopback') ? 400 : 500);
      }
    }],
  ];
}
