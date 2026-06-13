const blockedIps = new Set();

export function normalizeIp(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function isLoopback(ip) {
  const normalized = normalizeIp(ip);
  return normalized === '::1' || /^127\./.test(normalized);
}

export async function load(pool) {
  const { rows } = await pool.query('SELECT ip FROM ip_blocklist');
  for (const row of rows) {
    blockedIps.add(normalizeIp(row.ip));
  }
}

export function isBlocked(ip) {
  return blockedIps.has(normalizeIp(ip));
}

export async function block(pool, ip, reason) {
  if (isLoopback(ip)) {
    throw new Error(`Cannot block loopback address: ${ip}`);
  }
  const normalized = normalizeIp(ip);
  await pool.query(
    `INSERT INTO ip_blocklist (ip, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [normalized, reason ?? null]
  );
  blockedIps.add(normalized);
}

export async function unblock(pool, ip) {
  const normalized = normalizeIp(ip);
  await pool.query('DELETE FROM ip_blocklist WHERE ip = $1', [normalized]);
  blockedIps.delete(normalized);
}

export async function getAll(pool) {
  const { rows } = await pool.query(
    'SELECT ip, reason, blocked_at FROM ip_blocklist ORDER BY blocked_at DESC'
  );
  return rows;
}
