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
        // Prevent self-lockout: an operator cannot block the IP they are connecting
        // from (covers a non-loopback LAN IP, which the loopback guard does not catch).
        const requesterIp = blocklist.normalizeIp(req.socket.remoteAddress ?? '');
        if (blocklist.normalizeIp(ip) === requesterIp) {
          return err(res, 'cannot block your own address', 400);
        }
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
