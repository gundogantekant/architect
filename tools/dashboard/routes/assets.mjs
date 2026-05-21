import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';

const MAX_CONTENT_BYTES = 100 * 1024; // 100 KB
export const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

export function extractPlaceholders(content) {
  const found = new Set();
  let match;
  while ((match = PLACEHOLDER_RE.exec(content)) !== null) {
    found.add(match[1]);
  }
  // Reset lastIndex after use (regex is reused across calls)
  PLACEHOLDER_RE.lastIndex = 0;
  return [...found];
}

export async function resolveWithinRoot(requestedPath, projectRoot, roots) {
  // requestedPath is relative to projectRoot (e.g. "usecases/implement-work-item.md")
  // Resolve against projectRoot, then verify it falls inside one of the permitted roots.
  const candidate = resolve(projectRoot, requestedPath);
  try {
    const real = await realpath(candidate);
    for (const root of roots) {
      const realRoot = await realpath(root);
      if (real.startsWith(realRoot + '/') || real === realRoot) {
        return { realPath: real, root: realRoot };
      }
    }
  } catch {
    // Path does not exist or symlink resolution failed — deny access
  }
  return null;
}

async function scanFlat(dir, ext) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (!ext || entry.name.endsWith(ext))) {
        const fileStat = await stat(join(dir, entry.name));
        results.push({ name: entry.name, size: fileStat.size });
      }
    }
  } catch { /* directory absent — return empty */ }
  return results;
}

async function scanSkills(skillsDir) {
  const results = [];
  try {
    const subdirs = await readdir(skillsDir, { withFileTypes: true });
    for (const sub of subdirs) {
      if (!sub.isDirectory()) continue;
      const skillFile = join(skillsDir, sub.name, 'SKILL.md');
      try {
        const fileStat = await stat(skillFile);
        results.push({ name: sub.name, size: fileStat.size });
      } catch { /* SKILL.md absent — skip */ }
    }
  } catch { /* directory absent — return empty */ }
  return results;
}

async function scanRecursive(dir, baseDir) {
  const results = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await scanRecursive(fullPath, baseDir);
        results.push(...nested);
      } else if (entry.isFile()) {
        const fileStat = await stat(fullPath);
        results.push({ name: relative(baseDir, fullPath), size: fileStat.size });
      }
    }
  } catch { /* directory absent — return empty */ }
  return results;
}

export default function assetsRoutes(deps) {
  const { json, err, ROOT } = deps;

  const AGENTS_DIR  = join(ROOT, '.claude', 'agents');
  const SKILLS_DIR  = join(ROOT, '.claude', 'skills');
  const USECASES_DIR = join(ROOT, 'usecases');
  const TEMPLATES_DIR = join(ROOT, 'templates');

  const ROOTS = [AGENTS_DIR, SKILLS_DIR, USECASES_DIR, TEMPLATES_DIR];

  return [
    [/^\/api\/assets$/, 'GET', async (_m, _req, res) => {
      const [agentFiles, skillEntries, usecaseFiles, templateFiles] = await Promise.all([
        scanFlat(AGENTS_DIR, '.md'),
        scanSkills(SKILLS_DIR),
        scanFlat(USECASES_DIR, '.md'),
        scanRecursive(TEMPLATES_DIR, TEMPLATES_DIR),
      ]);

      const index = {
        agents:    agentFiles.map(f => ({ path: `.claude/agents/${f.name}`, size: f.size })),
        skills:    skillEntries.map(f => ({ path: `.claude/skills/${f.name}/SKILL.md`, size: f.size })),
        usecases:  usecaseFiles.map(f => ({ path: `usecases/${f.name}`, size: f.size })),
        templates: templateFiles.map(f => ({ path: `templates/${f.name}`, size: f.size })),
      };
      json(res, index);
    }],

    [/^\/api\/assets\/content$/, 'GET', async (_m, req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const requestedPath = url.searchParams.get('path');
      if (!requestedPath) return err(res, 'path parameter required', 400);

      const resolved = await resolveWithinRoot(requestedPath, ROOT, ROOTS);
      if (!resolved) return err(res, 'forbidden', 403);

      let raw;
      try {
        raw = await readFile(resolved.realPath);
      } catch {
        return err(res, 'not found', 404);
      }

      const truncated = raw.length > MAX_CONTENT_BYTES;
      const slice = truncated ? raw.slice(0, MAX_CONTENT_BYTES) : raw;

      let content;
      try {
        content = slice.toString('utf8');
        // Validate that the bytes decode cleanly as UTF-8
        Buffer.from(content, 'utf8');
      } catch {
        return json(res, { binary: true, preview: '[Binary file — preview not available]' });
      }

      // Detect replacement characters from invalid UTF-8 sequences
      if (content.includes('�')) {
        return json(res, { binary: true, preview: '[Binary file — preview not available]' });
      }

      if (truncated) content += '\n[Content truncated at 100 KB]';

      const placeholders = extractPlaceholders(content);
      json(res, { content, truncated, binary: false, placeholders });
    }],
  ];
}
