/**
 * Progress Events Tests (W-1205 Phase B)
 *
 * Tests for:
 * - POST /api/dispatch/:id/progress — agents emit ProgressEvent records
 * - GET /api/dispatch/:id/log?after=N — cursor-based log tailing
 *
 * Prerequisite: dashboard test server (managed by fixtures.mjs _workerPort).
 */

import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

const BASE_DISPATCH_ID = `D-progress-${Date.now()}`;

async function seedRunningDispatch(base, id, outputLines = []) {
  const logLines = outputLines.map(text => JSON.stringify({ type: 'content_block_delta', delta: { text } }));
  const resp = await fetch(`${base}/api/test/seed-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, status: 'running', log_lines: logLines }),
  });
  if (!resp.ok) throw new Error(`seed-dispatch failed: ${resp.status}`);
  return resp.json();
}

test.describe('Progress Events @fast', () => {

  test('PE-1: POST /progress with valid payload returns 204', async () => {
    const base = getBase();
    const id = `D-pe1-${Date.now()}`;
    await seedRunningDispatch(base, id);

    const resp = await fetch(`${base}/api/dispatch/${id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'testing', message: '30/30 pass' }),
    });
    expect(resp.status).toBe(204);
  });

  test('PE-2: POST /progress returns 404 for unknown dispatch ID', async () => {
    const base = getBase();

    const resp = await fetch(`${base}/api/dispatch/D-nonexistent/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'planning', message: 'should fail' }),
    });
    expect(resp.status).toBe(404);
  });

  test('PE-3: POST /progress returns 400 when phase is missing', async () => {
    const base = getBase();
    const id = `D-pe3-${Date.now()}`;
    await seedRunningDispatch(base, id);

    const resp = await fetch(`${base}/api/dispatch/${id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'no phase provided' }),
    });
    expect(resp.status).toBe(400);
  });

  test('PE-4: POST /progress returns 400 when message is empty', async () => {
    const base = getBase();
    const id = `D-pe4-${Date.now()}`;
    await seedRunningDispatch(base, id);

    const resp = await fetch(`${base}/api/dispatch/${id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'implementation', message: '' }),
    });
    expect(resp.status).toBe(400);
  });

  test('PE-5: POST /progress returns 400 when message exceeds 200 characters', async () => {
    const base = getBase();
    const id = `D-pe5-${Date.now()}`;
    await seedRunningDispatch(base, id);

    const longMessage = 'x'.repeat(201);
    const resp = await fetch(`${base}/api/dispatch/${id}/progress`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase: 'review', message: longMessage }),
    });
    expect(resp.status).toBe(400);
  });

  test('PE-6: GET /log?after=N returns only lines from index N onward', async () => {
    const base = getBase();
    const id = `D-pe6-${Date.now()}`;
    const lines = ['line-0', 'line-1', 'line-2', 'line-3', 'line-4'];
    await seedRunningDispatch(base, id, lines);

    const resp = await fetch(`${base}/api/dispatch/${id}/log?after=2`);
    expect(resp.ok).toBe(true);
    const body = await resp.text();
    const returnedLines = body.split('\n').filter(l => l.trim());
    // Seeded with 5 lines; after=2 means index 2, 3, 4 → 3 lines
    expect(returnedLines.length).toBe(3);
  });

});
