/**
 * Shared Playwright helpers for terminal experience tests.
 * All API helpers communicate with the live dashboard at BASE.
 */

const BASE = 'http://127.0.0.1:3777';

// ============================================================
// API helpers
// ============================================================

export async function api(path, opts = {}) {
  const url = `${BASE}/api/${path}`;
  const workerId = process.env.TEST_WORKER_INDEX;
  const workerHeader = workerId !== undefined ? { 'x-test-worker-id': String(workerId) } : {};
  const resp = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...workerHeader, ...opts.headers },
    ...opts,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`API ${opts.method || 'GET'} /${path} failed: ${resp.status} ${body}`);
  }
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

export async function purgeAll() {
  await api('test/purge-all', { method: 'POST' });
}

export async function seedTerminal(opts = {}) {
  const result = await api('test/seed-terminal', {
    method: 'POST',
    body: JSON.stringify(opts),
  });
  // Normalize: server returns terminal_id, tests use t.id
  if (result && result.terminal_id && !result.id) result.id = result.terminal_id;
  return result;
}

export async function pumpTerminal(terminalId, opts = {}) {
  return api('test/seed-terminal/pump', {
    method: 'POST',
    body: JSON.stringify({ terminalId, ...opts }),
  });
}

export async function getEventStream(terminalId) {
  return api(`test/terminal/${terminalId}/event-stream`);
}

export async function getActiveTerminals() {
  return api('terminal/active');
}

// ============================================================
// Playwright helpers
// ============================================================

/**
 * Wait for the terminal session to reach the LIVE state (or EXITED for completed terminals).
 * Uses window._termSessions which is exposed by the frontend.
 */
export async function waitForTerminalLive(page, terminalId, timeout = 20_000) {
  await page.waitForFunction(
    ({ id }) => {
      const s = window._termSessions?.get(id)?.state;
      return s === 'LIVE' || s === 'EXITED';
    },
    { id: terminalId },
    { timeout },
  );
}

/**
 * Wait until the xterm buffer has at least minLines non-empty lines.
 */
export async function waitForTerminalContent(page, terminalId, minLines = 10, timeout = 20_000) {
  await page.waitForFunction(
    ({ id, min }) => {
      const sess = window._termSessions?.get(id);
      if (!sess?._term) return false;
      const term = sess._term;
      const buf = term.buffer.active;
      const rows = term.rows || 24;
      let count = 0;
      for (let i = 0; i < Math.min(buf.length, buf.baseY + rows + 1); i++) {
        const line = buf.getLine(i);
        if (line && line.translateToString(true).trim().length > 0) count++;
        if (count >= min) return true;
      }
      return false;
    },
    { id: terminalId, min: minLines },
    { timeout, polling: 500 },
  );
}

/**
 * Read a slice of the xterm buffer as an array of strings.
 */
export async function getXtermBufferLines(page, terminalId, fromLine = 0, count = 50) {
  return page.evaluate(({ id, from, cnt }) => {
    const sess = window._termSessions?.get(id);
    if (!sess?._term) return [];
    const term = sess._term;
    const buf = term.buffer.active;
    const rows = term.rows || 24;
    const lines = [];
    const end = Math.min(from + cnt, Math.max(buf.length, buf.baseY + rows));
    for (let i = from; i < end; i++) {
      const line = buf.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }, { id: terminalId, from: fromLine, cnt: count });
}

/**
 * Return scroll metrics from the xterm buffer.
 * atBottom is true when viewportY >= baseY.
 */
export async function getXtermScrollMetrics(page, terminalId) {
  return page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (!sess?._term) return null;
    const term = sess._term;
    const buf = term.buffer.active;
    return {
      viewportY: buf.viewportY,
      baseY: buf.baseY,
      rows: term.rows,
      atBottom: buf.viewportY >= buf.baseY,
    };
  }, terminalId);
}

/**
 * Focus the xterm terminal and type text via keyboard events.
 * Waits for _term to be initialized before attempting to focus.
 */
export async function typeIntoTerminal(page, terminalId, text) {
  // Ensure _term is initialized (xterm loads async; LIVE state can precede init)
  await page.waitForFunction(
    (id) => !!window._termSessions?.get(id)?._term,
    terminalId,
    { timeout: 15_000 },
  );
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (sess?._term) sess._term.focus();
  }, terminalId);
  await page.keyboard.type(text);
}

/**
 * Wait for a string or regex pattern to appear in the xterm buffer.
 * Pattern can be a string or RegExp; RegExp is serialized via .source.
 */
export async function waitForTextInXterm(page, terminalId, pattern, timeout = 15_000) {
  const isRegex = pattern instanceof RegExp;
  await page.waitForFunction(
    ({ id, pat, isRe }) => {
      const sess = window._termSessions?.get(id);
      if (!sess?._term) return false;
      const term = sess._term;
      const buf = term.buffer.active;
      const rows = term.rows || 24;
      const re = isRe ? new RegExp(pat) : null;
      for (let i = 0; i <= buf.baseY + rows; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        if (re ? re.test(text) : text.includes(pat)) return true;
      }
      return false;
    },
    { id: terminalId, pat: isRegex ? pattern.source : pattern, isRe: isRegex },
    { timeout },
  );
}

/**
 * Wait for the session-id footer element to be non-empty.
 */
export async function waitForFooterSessionId(page, terminalId, timeout = 10_000) {
  await page.waitForSelector(`#terminal-${terminalId} .session-id-copy:not(:empty)`, { timeout });
}

/**
 * Return a snapshot of the session state object exposed on window._termSessions.
 */
export async function getSessionState(page, terminalId) {
  return page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (!sess) return null;
    return {
      state: sess.state,
      claudeSessionId: sess.claudeSessionId,
      firstLiveSeen: sess.firstLiveSeen,
    };
  }, terminalId);
}

/**
 * Compare the first lineCount non-empty buffer lines from two terminals on two pages.
 * Returns { match, lines1, lines2 }.
 */
export async function compareXtermBuffers(page1, terminalId1, page2, terminalId2, lineCount = 50) {
  const lines1 = await getXtermBufferLines(page1, terminalId1, 0, lineCount);
  const lines2 = await getXtermBufferLines(page2, terminalId2, 0, lineCount);
  const nonEmpty1 = lines1.filter((l) => l.trim());
  const nonEmpty2 = lines2.filter((l) => l.trim());
  const match =
    JSON.stringify(nonEmpty1.slice(0, 20)) === JSON.stringify(nonEmpty2.slice(0, 20));
  return { match, lines1: nonEmpty1.slice(0, 20), lines2: nonEmpty2.slice(0, 20) };
}
