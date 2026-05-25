const VALID_ORG_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const BLOCKED_ORG_NAMES = new Set(['test', 'testorg', 'fake', 'tmp', 'demo', 'dev', 'local', 'debug']);

export function validateOrgName(name) {
  if (!name || typeof name !== 'string') return { ok: false, reason: 'org name required' };
  if (!VALID_ORG_RE.test(name)) return { ok: false, reason: `org name must start with a letter and contain only [a-zA-Z0-9_-]: '${name}'` };
  if (BLOCKED_ORG_NAMES.has(name.toLowerCase())) return { ok: false, reason: `'${name}' is a reserved/suspicious org name` };
  return { ok: true };
}
