/**
 * Access guard for the dashboard HTTP server.
 *
 * The dashboard has NO authentication but binds to the LAN by default, and its
 * dispatch/terminal endpoints are effectively remote code execution. This guard is the
 * defence-in-depth layer: it validates the Host header (DNS-rebinding protection), an
 * optional client-IP allow-list, the IP deny-list (blocklist), and same-origin for
 * mutating requests (CSRF protection).
 *
 * `evaluateRequest` is PURE and side-effect-free: all stateful collaborators (blocklist
 * lookups, IP normalization) are injected via `config`, so it can be unit-tested in
 * isolation. Loopback clients are ALWAYS exempt — that is the guaranteed local recovery
 * path even if every list is misconfigured.
 */

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/**
 * Extract the hostname from a Host or Origin/Referer host string, stripping the port and
 * handling bracketed IPv6 (`[::1]:3777`). Returns lowercased hostname, or '' if absent.
 */
export function parseHostname(value) {
  if (!value) return '';
  let host = String(value).trim();
  // Origin/Referer may carry a scheme — strip it and any path.
  const schemeIdx = host.indexOf('://');
  if (schemeIdx !== -1) host = host.slice(schemeIdx + 3);
  const slashIdx = host.indexOf('/');
  if (slashIdx !== -1) host = host.slice(0, slashIdx);
  if (host.startsWith('[')) {
    // Bracketed IPv6: [::1]:3777 → ::1
    const close = host.indexOf(']');
    if (close !== -1) return host.slice(1, close).toLowerCase();
    return host.slice(1).toLowerCase();
  }
  // Strip :port (only when a single colon — bare IPv6 has multiple).
  const colonIdx = host.indexOf(':');
  if (colonIdx !== -1 && host.indexOf(':', colonIdx + 1) === -1) {
    host = host.slice(0, colonIdx);
  }
  return host.toLowerCase();
}

function isAllowedHostname(hostname, { allowedHosts, serverLanIps, normalizeIp }) {
  if (!hostname) return false;
  if (LOOPBACK_NAMES.has(hostname)) return true;
  const normalized = normalizeIp(hostname);
  if (LOOPBACK_NAMES.has(normalized)) return true;
  if (serverLanIps.some(ip => normalizeIp(ip) === normalized)) return true;
  if (allowedHosts.some(h => h.toLowerCase() === hostname)) return true;
  return false;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {{clientIp:string, host:string, origin:string, method:string, path:string}} req
 * @param {{allowedHosts:string[], allowIps:string[], serverLanIps:string[],
 *          isBlocked:(ip:string)=>boolean, isLoopback:(ip:string)=>boolean,
 *          normalizeIp:(ip:string)=>string}} config
 * @returns {{allow:boolean, status?:number, reason?:string}}
 */
export function evaluateRequest(req, config) {
  const { clientIp, host, origin, method } = req;
  const { allowIps, isBlocked, isLoopback, normalizeIp } = config;

  // 1. Loopback is always exempt — guaranteed local recovery path.
  if (isLoopback(clientIp)) return { allow: true };

  // 2. Host-header validation (DNS-rebinding protection) — applies to all requests.
  const hostname = parseHostname(host);
  if (!isAllowedHostname(hostname, config)) {
    return { allow: false, status: 403, reason: 'host not allowed' };
  }

  // 3. Client-IP allow-list (opt-in). When set, the client IP must be present.
  if (allowIps.length > 0) {
    const normalizedClient = normalizeIp(clientIp);
    const inList = allowIps.some(entry => ipMatches(entry, normalizedClient, normalizeIp));
    if (!inList) {
      return { allow: false, status: 403, reason: 'IP not in allow-list' };
    }
  }

  // 4. IP deny-list (blocklist).
  if (isBlocked(clientIp)) {
    return { allow: false, status: 403, reason: 'IP blocked' };
  }

  // 5. CSRF / same-origin for mutating methods. Absent Origin → programmatic (curl) → allow.
  if (MUTATING.has(method) && origin) {
    const originHost = parseHostname(origin);
    if (!isAllowedHostname(originHost, config)) {
      return { allow: false, status: 403, reason: 'cross-origin' };
    }
  }

  return { allow: true };
}

/**
 * Best-effort IP match: exact equality, or a CIDR prefix match for `a.b.c.d/N` entries.
 * Non-CIDR entries fall back to string equality (after normalization).
 */
function ipMatches(entry, clientIp, normalizeIp) {
  const slash = entry.indexOf('/');
  if (slash === -1) {
    return normalizeIp(entry) === clientIp;
  }
  const base = normalizeIp(entry.slice(0, slash));
  const bits = parseInt(entry.slice(slash + 1), 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  // Best-effort IPv4 CIDR only.
  const toInt = (ip) => {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
      const o = Number(p);
      if (!Number.isInteger(o) || o < 0 || o > 255) return null;
      n = (n << 8) | o;
    }
    return n >>> 0;
  };
  const baseInt = toInt(base);
  const clientInt = toInt(clientIp);
  if (baseInt === null || clientInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (baseInt & mask) === (clientInt & mask);
}
