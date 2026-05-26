// POST used because request body carries portfolio context, not for mutation

import { readFile, stat } from 'node:fs/promises';
import { PROMPTS_DIR, TRUNCATION_LIMIT } from '../constants.mjs';
import { extractPlaceholders, PLACEHOLDER_RE, resolveWithinRoot } from './assets.mjs';

const BODY_LIMIT = 512 * 1024;

const TEMPLATE_REGISTRY = new Map([
  ['dispatch', 'dispatch.md'],
  ['refinement', 'refinement.md'],
  // migration: "refinement_v1" → "refinement" on 2026-05-21
  ['_test_large', 'large.md'],        // test-only: verifies truncation at TRUNCATION_LIMIT
  ['_test_corrupt', 'corrupt.md'],    // test-only: verifies render_failed on binary content
  ['_test_traversal', '../../../etc/passwd'],  // security probe: verifies path containment rejects out-of-bounds paths
]);

async function accumulateBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_LIMIT) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default function promptsRoutes(deps) {
  const { json } = deps;

  return [
    [/^\/api\/prompts\/preview$/, 'POST', async (_m, req, res) => {
      const rawBody = await accumulateBody(req);
      if (rawBody === null) {
        return json(res, { error: 'Request body exceeds 512KB limit', code: 'body_too_large' }, 413);
      }

      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return json(res, { error: 'Invalid request body', code: 'render_failed' }, 400);
      }

      const { template_id, variables = {} } = parsed;

      const filename = TEMPLATE_REGISTRY.get(template_id);
      if (filename === undefined) {
        return json(res, { error: `Unknown template: ${template_id}`, code: 'template_not_found' }, 404);
      }

      try {
        const s = await stat(PROMPTS_DIR);
        if (!s.isDirectory()) throw new Error('not a directory');
      } catch {
        return json(res, { error: 'Prompts directory not found', code: 'config_error' }, 503);
      }

      const resolved = await resolveWithinRoot(filename, PROMPTS_DIR, [PROMPTS_DIR]);
      if (!resolved) {
        return json(res, { error: 'Invalid path', code: 'invalid_path' }, 400);
      }

      let raw;
      try {
        raw = await readFile(resolved.realPath);
      } catch {
        return json(res, { error: 'Failed to load template', code: 'render_failed' }, 500);
      }

      const content = raw.toString('utf8');
      if (content.includes('�')) {
        return json(res, { error: 'Template contains binary content', code: 'render_failed' }, 500);
      }

      // no caching — templates change during active development
      let rendered;
      try {
        rendered = content.replace(PLACEHOLDER_RE, (_, token) => {
          const val = variables[token];
          return val !== undefined ? String(val) : `{{${token}}}`;
        });
        PLACEHOLDER_RE.lastIndex = 0;
      } catch (e) {
        return json(res, { error: 'Template render failed', code: 'render_failed' }, 500);
      }

      const placeholders = extractPlaceholders(rendered);

      const truncated = Buffer.byteLength(rendered, 'utf8') > TRUNCATION_LIMIT;
      if (truncated) {
        rendered = Buffer.from(rendered, 'utf8').slice(0, TRUNCATION_LIMIT).toString('utf8');
      }

      json(res, { rendered, placeholders, truncated });
    }],
  ];
}
