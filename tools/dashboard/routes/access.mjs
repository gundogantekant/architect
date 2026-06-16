// IPv4 (incl. ::ffff: mapped) and IPv6 validation. Mirrors the normalization in
// lib/blocklist.mjs so a malformed path segment is rejected before touching the DB.
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;
function isValidIp(ip) {
  const candidate = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (IPV4.test(candidate)) return true;
  // IPv6: must contain a colon and only hex/colon characters.
  return ip.includes(':') && IPV6.test(ip);
}

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
        if (!isValidIp(ip)) return err(res, 'invalid IP', 400);
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
        if (!isValidIp(ip)) return err(res, 'invalid IP', 400);
        await blocklist.unblock(db.getPool(), ip);
        json(res, { ok: true });
      } catch (e) {
        err(res, e.message, e.message.includes('loopback') ? 400 : 500);
      }
    }],
  ];
}
