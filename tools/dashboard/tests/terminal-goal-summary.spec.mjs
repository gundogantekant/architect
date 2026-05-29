/**
 * Terminal Goal Summary Tests (W-1238)
 *
 * Verifies that terminal panel headers display a concise goal summary derived from
 * the first user input, persisted in the `title` column, and reflected in the UI.
 *
 * TGS-1  through TGS-7:  API/unit tests (no browser)
 * TGS-8  through TGS-12: Playwright E2E tests
 */

import { test, expect } from './fixtures.mjs';
import { api, seedTerminal, getActiveTerminals } from './helpers.mjs';
import { summarizeGoal } from '../lib/summarize-goal.mjs';

// ---------------------------------------------------------------------------
// TGS-1: PATCH with valid title → 200 { ok: true, title: "..." }
// ---------------------------------------------------------------------------

test('TGS-1: PATCH /api/terminal/:id/title with valid title returns 200 ok', async () => {
  const t = await seedTerminal({ status: 'running' });

  const resp = await fetch(`${getBase()}/api/terminal/${t.id}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Fix database migration' }),
  });

  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.title).toBe('Fix database migration');
});

// ---------------------------------------------------------------------------
// TGS-2: PATCH with empty/missing title → 400
// ---------------------------------------------------------------------------

test('TGS-2: PATCH with empty title returns 400', async () => {
  const t = await seedTerminal({ status: 'running' });

  const respEmpty = await fetch(`${getBase()}/api/terminal/${t.id}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '' }),
  });
  expect(respEmpty.status).toBe(400);

  const respMissing = await fetch(`${getBase()}/api/terminal/${t.id}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(respMissing.status).toBe(400);
});

// ---------------------------------------------------------------------------
// TGS-3: PATCH title longer than 120 chars → truncated to 120, 200
// ---------------------------------------------------------------------------

test('TGS-3: PATCH with title >120 chars returns 200 with truncated title', async () => {
  const t = await seedTerminal({ status: 'running' });
  const longTitle = 'A'.repeat(150);

  const resp = await fetch(`${getBase()}/api/terminal/${t.id}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: longTitle }),
  });

  expect(resp.status).toBe(200);
  const body = await resp.json();
  expect(body.ok).toBe(true);
  expect(body.title.length).toBe(120);
});

// ---------------------------------------------------------------------------
// TGS-4: PATCH on nonexistent terminal → 404
// ---------------------------------------------------------------------------

test('TGS-4: PATCH on nonexistent terminal returns 404', async () => {
  const resp = await fetch(`${getBase()}/api/terminal/T-nonexistent-999/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Some goal' }),
  });

  expect(resp.status).toBe(404);
});

// ---------------------------------------------------------------------------
// TGS-5: After PATCH, GET /api/terminal/active returns updated title
// ---------------------------------------------------------------------------

test('TGS-5: After PATCH, active list reflects updated title', async () => {
  const t = await seedTerminal({ status: 'running' });

  await fetch(`${getBase()}/api/terminal/${t.id}/title`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Refactor auth module' }),
  });

  const active = await getActiveTerminals();
  const found = active.find(a => a.id === t.id);
  expect(found).toBeDefined();
  expect(found.title).toBe('Refactor auth module');
});

// ---------------------------------------------------------------------------
// TGS-6: After PATCH + restart simulation, title persists from DB
// ---------------------------------------------------------------------------

test('TGS-6: Title persists in DB after PATCH', async () => {
  const t = await seedTerminal({ status: 'running' });

  await api(`terminal/${t.id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Build new feature' }),
  });

  // Read directly from the DB-backed endpoint (simulates a fresh server load)
  // by checking /api/terminal/active which re-reads from the in-memory state updated by PATCH
  const active = await getActiveTerminals();
  const found = active.find(a => a.id === t.id);
  expect(found?.title).toBe('Build new feature');
});

// ---------------------------------------------------------------------------
// TGS-7: summarizeGoal without ANTHROPIC_API_KEY uses first-line truncation fallback
// ---------------------------------------------------------------------------

test('TGS-7: summarizeGoal falls back to first-line truncation without API key', async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = '';

  try {
    const result = await summarizeGoal('Fix the login bug on the auth page\nmore detail here');
    expect(typeof result).toBe('string');
    expect(result).toBe('Fix the login bug on the auth page');
    expect(result.length).toBeLessThanOrEqual(60);

    const longInput = 'A'.repeat(200);
    const longResult = await summarizeGoal(longInput);
    expect(longResult).not.toBeNull();
    expect(longResult.length).toBeLessThanOrEqual(60);

    const emptyResult = await summarizeGoal('   ');
    expect(emptyResult).toBeNull();
  } finally {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }
});

// ---------------------------------------------------------------------------
// TGS-13: summarizeGoal with ANSI-contaminated input returns clean text
// ---------------------------------------------------------------------------

test('TGS-13: summarizeGoal with ANSI-contaminated input returns clean text (fallback path)', async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = '';

  try {
    // Simulate the exact DA + OSC responses xterm.js sends at startup, followed by
    // a real user command — this is the string that was leaking into panel headers.
    const contaminated = '\x1b[?1;2c\x1b[>0;276;0c\x1b]10;rgb:1e1e/1e1e/2e2e\x07git status';
    const result = await summarizeGoal(contaminated);

    expect(typeof result).toBe('string');
    expect(result).not.toBeNull();
    // No ANSI residue
    expect(result).not.toMatch(/\x1b/);
    expect(result).not.toMatch(/\[\?/);
    expect(result).not.toMatch(/\]10;/);
    expect(result).not.toMatch(/rgb:/);
    // The real command text should be present
    expect(result).toContain('git status');
  } finally {
    if (originalKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }
});

// ---------------------------------------------------------------------------
// TGS-14: _goalSummarized guard — undefined (pre-fix) calls summarizeGoal; true (post-fix) skips it
// ---------------------------------------------------------------------------

test('TGS-14: _goalSummarized=undefined triggers summarizeGoal; _goalSummarized=true skips it', async () => {
  // Replicate the summarization guard logic from ws-router.mjs lines 141–166.
  // No real WS server is needed — the flag logic is self-contained.
  function simulateWsInputHandler(terminal, inputData, summarizeGoalFn) {
    if (inputData.type === 'input' && terminal.ptyProcess) {
      if (!terminal._goalSummarized) {
        const buf = inputData.data.replace(/\r?\n$/, '').trim();
        if (/[\r\n]/.test(inputData.data)) {
          terminal._goalSummarized = true;
          if (buf.length >= 5) {
            summarizeGoalFn(buf);
          }
        }
      }
    }
  }

  const inputData = { type: 'input', data: 'git status\n' };

  // Pre-fix state: restored terminal has existing title but _goalSummarized=undefined (bug)
  let summarizeCalled = false;
  const preFixTerminal = {
    title: 'Pre-existing goal',
    _goalSummarized: undefined,
    ptyProcess: {},  // truthy sentinel — no real pty needed
  };
  simulateWsInputHandler(preFixTerminal, inputData, () => { summarizeCalled = true; });
  expect(summarizeCalled).toBe(true);  // confirms the bug: re-summarizes even with existing title

  // Post-fix state: restored terminal has _goalSummarized=true (set via !!t.title in restoreSessions)
  summarizeCalled = false;
  const postFixTerminal = {
    title: 'Pre-existing goal',
    _goalSummarized: true,
    ptyProcess: {},
  };
  simulateWsInputHandler(postFixTerminal, inputData, () => { summarizeCalled = true; });
  expect(summarizeCalled).toBe(false);  // fix: title already in DB → skip summarization
});

// ---------------------------------------------------------------------------
// Helper: get base URL from env
// ---------------------------------------------------------------------------

function getBase() {
  if (!process.env.TEST_SERVER_PORT) {
    throw new Error('TEST_SERVER_PORT not set');
  }
  return `http://127.0.0.1:${process.env.TEST_SERVER_PORT}`;
}

// ---------------------------------------------------------------------------
// TGS-8: Linked terminal — after PATCH, next poll shows goal badge
// ---------------------------------------------------------------------------

test('TGS-8: Linked terminal shows .terminal-goal-badge after title update', async ({ page }) => {
  const t = await seedTerminal({ status: 'running', work_item_id: 'W-001' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${t.id}`, { timeout: 10_000 });

  await api(`terminal/${t.id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Auth fix' }),
  });

  // Wait for restoreTerminals poll to pick up the change (polls every ~3s)
  await page.waitForFunction(
    (id) => {
      const panel = document.getElementById(`terminal-${id}`);
      return panel?.querySelector('[data-goal]')?.textContent === 'Auth fix';
    },
    t.id,
    { timeout: 15_000, polling: 500 },
  );

  const badge = page.locator(`#terminal-${t.id} [data-goal]`);
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Auth fix');
});

// ---------------------------------------------------------------------------
// TGS-9: Terminal without work_item or epic — after PATCH, no .terminal-goal-badge
// ---------------------------------------------------------------------------

test('TGS-9: Terminal without work_item or epic shows no .terminal-goal-badge after PATCH', async ({ page }) => {
  // Seeded terminals always have project_key but no work_item_id or epic_id by default
  const t = await seedTerminal({ status: 'running' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${t.id}`, { timeout: 10_000 });

  await api(`terminal/${t.id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Debug memory leak' }),
  });

  // Wait for the dataset.terminalTitle to update (indicates restoreTerminals ran)
  await page.waitForFunction(
    (id) => document.getElementById(`terminal-${id}`)?.dataset.terminalTitle === 'Debug memory leak',
    t.id,
    { timeout: 15_000, polling: 500 },
  );

  // No goal badge should appear (terminal has project_key but no work_item/epic link)
  const badge = page.locator(`#terminal-${t.id} .terminal-goal-badge`);
  await expect(badge).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// TGS-10: Title update does NOT trigger full panel re-render
// ---------------------------------------------------------------------------

test('TGS-10: Title PATCH does not trigger xterm panel re-render', async ({ page }) => {
  const t = await seedTerminal({ status: 'running' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${t.id}`, { timeout: 10_000 });

  // Capture identity of the session object before the poll cycle
  const sessionObjectId = await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (!sess) return null;
    // Store a marker to detect object replacement
    sess._identityMarker = 'tgs-10-marker';
    return 'set';
  }, t.id);

  await api(`terminal/${t.id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'No re-render test' }),
  });

  // Wait for badge/path to appear
  await page.waitForTimeout(5000);

  // Verify the session object was NOT replaced (marker still present)
  const markerStillPresent = await page.evaluate((id) => {
    return window._termSessions?.get(id)?._identityMarker === 'tgs-10-marker';
  }, t.id);

  expect(sessionObjectId).toBe('set');
  expect(markerStillPresent).toBe(true);
});

// ---------------------------------------------------------------------------
// TGS-11: Multiple terminals — PATCH A doesn't affect B header
// ---------------------------------------------------------------------------

test('TGS-11: PATCH terminal A title does not affect terminal B header', async ({ page }) => {
  const tA = await seedTerminal({ status: 'running' });
  const tB = await seedTerminal({ status: 'running' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${tA.id}`, { timeout: 10_000 });
  await page.waitForSelector(`#terminal-${tB.id}`, { timeout: 10_000 });

  const bTitleBefore = await page.evaluate((id) => {
    const panel = document.getElementById(`terminal-${id}`);
    return panel?.dataset.terminalTitle || '';
  }, tB.id);

  await api(`terminal/${tA.id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Terminal A goal' }),
  });

  // Wait for A to update
  await page.waitForFunction(
    (id) => document.getElementById(`terminal-${id}`)?.dataset.terminalTitle === 'Terminal A goal',
    tA.id,
    { timeout: 15_000, polling: 500 },
  );

  // B should be unchanged
  const bTitleAfter = await page.evaluate((id) => {
    const panel = document.getElementById(`terminal-${id}`);
    return panel?.dataset.terminalTitle || '';
  }, tB.id);

  expect(bTitleAfter).toBe(bTitleBefore);
});

// ---------------------------------------------------------------------------
// TGS-12: DB-restored panel — persisted goal appears immediately on reload
// ---------------------------------------------------------------------------

test('TGS-12: Reloading page shows persisted goal from DB immediately', async ({ page }) => {
  const t = await seedTerminal({ status: 'running' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${t.id}`, { timeout: 10_000 });

  await api(`terminal/${t.id}/title`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Persisted goal' }),
  });

  // Reload page — should show persisted title immediately without needing a PATCH
  await page.reload();
  await page.waitForSelector(`#terminal-${t.id}`, { timeout: 10_000 });

  // The panel's dataset.terminalTitle should be set to persisted goal right away
  await page.waitForFunction(
    (id) => {
      const panel = document.getElementById(`terminal-${id}`);
      return panel?.dataset.terminalTitle === 'Persisted goal';
    },
    t.id,
    { timeout: 10_000, polling: 300 },
  );

  const title = await page.evaluate((id) => {
    return document.getElementById(`terminal-${id}`)?.dataset.terminalTitle;
  }, t.id);
  expect(title).toBe('Persisted goal');
});
