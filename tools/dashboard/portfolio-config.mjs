import { readdir, readFile } from 'fs/promises';
import { join } from 'path';

const RESERVED_PREFIXES = new Set(['W', 'E']);
const VALID_PREFIX = /^[A-Z][A-Z0-9]*$/;

export async function buildPrefixCache(portfolioDir) {
  const cache = new Map(); // projectKey → { prefix, ticketStart }
  const prefixToProject = new Map(); // prefix → projectKey (for dupe detection)
  const conflicting = new Set(); // prefixes to exclude due to conflict

  try {
    const orgs = await readdir(portfolioDir, { withFileTypes: true });
    for (const orgEntry of orgs) {
      if (!orgEntry.isDirectory()) continue; // skip registry.json etc
      const orgDir = join(portfolioDir, orgEntry.name);
      const projects = await readdir(orgDir, { withFileTypes: true }).catch(() => []);
      for (const projEntry of projects) {
        if (!projEntry.isDirectory()) continue; // skip organization.json
        const projDir = join(orgDir, projEntry.name);
        const components = await readdir(projDir).catch(() => []);
        for (const filename of components) {
          if (!filename.endsWith('.json')) continue;
          const component = filename.slice(0, -5);
          const projectKey = `${orgEntry.name}/${projEntry.name}/${component}`;
          try {
            const raw = await readFile(join(projDir, filename), 'utf8');
            const data = JSON.parse(raw);
            const prefix = data.ticket_prefix;
            if (!prefix) continue;
            if (!VALID_PREFIX.test(prefix) || RESERVED_PREFIXES.has(prefix)) {
              console.warn(`[prefix-cache] WARN: invalid ticket_prefix "${prefix}" in ${projectKey} — skipped (must match ^[A-Z][A-Z0-9]*$ and not be W or E)`);
              continue;
            }
            const ticketStart = (typeof data.ticket_start === 'number' && Number.isInteger(data.ticket_start) && data.ticket_start >= 1) ? data.ticket_start : 1;
            if (prefixToProject.has(prefix)) {
              const other = prefixToProject.get(prefix);
              console.warn(`[prefix-cache] WARN: prefix "${prefix}" claimed by both ${projectKey} and ${other} — excluded from cache to prevent ID collisions`);
              conflicting.add(prefix);
              cache.delete(other); // remove the first claimant too
              continue;
            }
            if (conflicting.has(prefix)) continue;
            cache.set(projectKey, { prefix, ticketStart });
            prefixToProject.set(prefix, projectKey);
          } catch (e) {
            console.warn(`[prefix-cache] WARN: failed to read ${projectKey}: ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[prefix-cache] WARN: could not scan portfolio dir: ${e.message}`);
  }

  const count = cache.size;
  if (count === 0) {
    console.log('[prefix-cache] no custom prefixes configured');
  } else {
    const entries = [...cache.entries()].map(([k, v]) => `${v.prefix} → ${k}`).join(', ');
    console.log(`[prefix-cache] loaded ${count} prefix(es): ${entries}`);
  }
  return cache;
}
