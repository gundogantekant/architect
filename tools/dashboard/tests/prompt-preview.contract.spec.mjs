/**
 * Prompt Preview API Contract Tests — W-1197
 *
 * PP-1: POST dispatch template with full variables → rendered, no unfilled placeholders
 * PP-2: POST with missing context variables → partial render, placeholders listed
 * PP-3: POST with unknown template_id → 404 template_not_found
 * PP-4: POST with corrupt (binary) fixture template → 500 render_failed
 * PP-5: POST body > 512KB → 413 body_too_large
 * PP-6: POST producing rendered content > 100KB → truncated: true
 * PP-7: POST _test_traversal template_id → 400 invalid_path
 * PP-8: POST when PROMPTS_DIR absent → 503 config_error (first, before seeding)
 * PP-9: POST semantics comment present in routes/prompts.mjs
 *
 * Tests PP-3, PP-5, and PP-8 run before the prompts directory is seeded.
 * PP-8 seeds the directory at its end so subsequent tests work.
 *
 * Contract test uses fixture templates in tests/fixtures/prompts/ — no W-1196 dependency.
 */

import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_PORT } from './server-utils.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const FIXTURES_PROMPTS = join(ROOT, 'tools', 'dashboard', 'tests', 'fixtures', 'prompts');

function getPromptsDir() {
  const port = Number(process.env.TEST_SERVER_PORT);
  const idx = port - BASE_PORT;
  return join(ROOT, 'tmp', `pw-s${idx}`, 'prompts');
}

async function postPreview(request, body) {
  return request.post(`${getBase()}/api/prompts/preview`, {
    data: body,
    headers: { 'Content-Type': 'application/json' },
  });
}

test.describe.serial('Prompt Preview API @fast', () => {

  test('PP-3: unknown template_id → 404 template_not_found', async ({ request }) => {
    const resp = await postPreview(request, { template_id: 'nonexistent_xyz', variables: {} });
    expect(resp.status()).toBe(404);
    const body = await resp.json();
    expect(body.error).toContain('nonexistent_xyz');
    expect(body.code).toBe('template_not_found');
  });

  test('PP-5: body > 512KB → 413 body_too_large', async ({ request }) => {
    const bigVariables = { PADDING: 'x'.repeat(513 * 1024) };
    const resp = await postPreview(request, { template_id: 'dispatch', variables: bigVariables });
    expect(resp.status()).toBe(413);
    const body = await resp.json();
    expect(body.error).toContain('512KB');
    expect(body.code).toBe('body_too_large');
  });

  test('PP-8: PROMPTS_DIR absent → 503 config_error, then seed prompts dir', async ({ request }) => {
    const resp = await postPreview(request, { template_id: 'dispatch', variables: {} });
    expect(resp.status()).toBe(503);
    const body = await resp.json();
    expect(body.code).toBe('config_error');

    // Seed the prompts directory for all subsequent tests in this serial describe
    const promptsDir = getPromptsDir();
    mkdirSync(promptsDir, { recursive: true });

    writeFileSync(
      join(promptsDir, 'dispatch.md'),
      readFileSync(join(FIXTURES_PROMPTS, 'dispatch.md')),
    );
    writeFileSync(
      join(promptsDir, 'refinement.md'),
      readFileSync(join(FIXTURES_PROMPTS, 'refinement.md')),
    );
    // large.md: 110 KB of text to exceed TRUNCATION_LIMIT (100 KB)
    writeFileSync(
      join(promptsDir, 'large.md'),
      'A'.repeat(110 * 1024),
    );
    // corrupt.md: binary content — non-UTF-8 bytes trigger render_failed
    writeFileSync(
      join(promptsDir, 'corrupt.md'),
      Buffer.from([0xFF, 0xFE, 0x00, 0x01]),
    );
  });

  test('PP-1: full render with all variables → rendered, placeholders empty', async ({ request }) => {
    const resp = await postPreview(request, {
      template_id: 'dispatch',
      variables: { ORG: 'acme', PROJECT: 'api', COMPONENT: 'main' },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(typeof body.rendered).toBe('string');
    expect(body.rendered).toContain('acme');
    expect(body.rendered).toContain('api');
    expect(body.rendered).toContain('main');
    expect(body.rendered).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
    expect(body.placeholders).toEqual([]);
    expect(body.truncated).toBe(false);
  });

  test('PP-2: missing context variables → partial render, placeholders listed', async ({ request }) => {
    const resp = await postPreview(request, {
      template_id: 'dispatch',
      variables: { ORG: 'acme' }, // PROJECT and COMPONENT missing
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(typeof body.rendered).toBe('string');
    expect(body.rendered).toContain('acme');
    expect(body.rendered).toContain('{{PROJECT}}');
    expect(body.rendered).toContain('{{COMPONENT}}');
    expect(Array.isArray(body.placeholders)).toBe(true);
    expect(body.placeholders).toContain('PROJECT');
    expect(body.placeholders).toContain('COMPONENT');
    expect(body.placeholders).not.toContain('ORG');
    expect(body.truncated).toBe(false);
  });

  test('PP-4: corrupt fixture → 500 render_failed', async ({ request }) => {
    const resp = await postPreview(request, { template_id: '_test_corrupt', variables: {} });
    expect(resp.status()).toBe(500);
    const body = await resp.json();
    expect(typeof body.error).toBe('string');
    expect(body.code).toBe('render_failed');
  });

  test('PP-6: template rendering > 100KB → truncated: true, content within limit', async ({ request }) => {
    const resp = await postPreview(request, { template_id: '_test_large', variables: {} });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.rendered, 'utf8')).toBeLessThanOrEqual(100 * 1024);
  });

  test('PP-7: _test_traversal template_id → 400 invalid_path', async ({ request }) => {
    const resp = await postPreview(request, { template_id: '_test_traversal', variables: {} });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.code).toBe('invalid_path');
  });

  test('PP-9: POST semantics comment present in routes/prompts.mjs', async () => {
    const source = readFileSync(
      join(ROOT, 'tools', 'dashboard', 'routes', 'prompts.mjs'),
      'utf8',
    );
    expect(source).toContain('POST used because request body carries portfolio context');
  });

});
