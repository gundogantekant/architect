/**
 * Prompt Injection Contract Tests (CI-1 through CI-5)
 *
 * Guards the W-1249 fix: injectPrompt must deliver the bracketed paste block
 * with zero delay between chunks so Ink's event loop cannot interleave and
 * treat intermediate \n characters as Enter keystrokes.
 *
 * CI-1: Short prompt (< 512 chars) → start marker, content, end marker, no extra writes
 * CI-2: Long prompt (> 512 chars) → all content present across chunks, none lost
 * CI-3: Multi-line prompt → all \n characters preserved inside the paste block
 * CI-4: Unicode content → passes through sanitizePrompt intact
 * CI-5: Empty after sanitization → no ptyProcess.write() called
 *
 * Follow-on to W-1237 (readiness timing fix). See adapters/claude.mjs for
 * the \x1b[?2004h readiness detection that gates injection.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

function makeMockTerminal(prompt) {
  const writes = [];
  const events = [];
  const terminal = {
    id: `ci-test-${Math.random().toString(36).slice(2)}`,
    _pendingPrompt: prompt,
    pid: null,
    tmux_session: null,
    ptyProcess: {
      write: (data) => writes.push(data),
      kill: () => {},
    },
    eventStream: {
      append: (_type, data) => { events.push(data); return data; },
      broadcast: () => {},
    },
  };
  return { terminal, writes, events };
}

function reconstructContent(writes) {
  // Join all writes and strip the bracketed paste markers + trailing \r to recover the prompt.
  return writes.join('').replace('\x1b[200~', '').replace('\x1b[201~\r', '');
}

describe('CI: injectPrompt bracketed paste contract', () => {
  let injectPrompt;

  before(async () => {
    // Dynamic import so the module resolves from its own directory (same as EP-5/EP-6/EP-7).
    ({ injectPrompt } = await import('../pty-manager.mjs'));
  });

  it('CI-1: short prompt writes start marker, content, and end+CR', () => {
    const prompt = 'Short test prompt — under 512 chars.';
    const { terminal, writes } = makeMockTerminal(prompt);

    injectPrompt(terminal);

    assert.ok(writes.length >= 3, 'must have at least 3 writes: start, content, end');
    assert.equal(writes[0], '\x1b[200~', 'first write must be bracketed paste start');
    const last = writes[writes.length - 1];
    assert.ok(last.endsWith('\x1b[201~\r'), 'last write must end with bracketed paste end + \\r');
    assert.equal(reconstructContent(writes), prompt, 'reconstructed content must equal original prompt');
  });

  it('CI-2: long prompt (> 512 chars) delivers all content without omission', () => {
    const prompt = 'Alpha '.repeat(50) + '\n' + 'Beta '.repeat(50) + '\n' + 'Gamma '.repeat(50);
    assert.ok(prompt.length > 512, 'test precondition: prompt must exceed chunk size');
    const { terminal, writes } = makeMockTerminal(prompt);

    injectPrompt(terminal);

    assert.equal(writes[0], '\x1b[200~', 'first write must be bracketed paste start');
    const reconstructed = reconstructContent(writes);
    assert.equal(reconstructed.length, prompt.length, 'no characters may be lost across chunk boundaries');
    assert.equal(reconstructed, prompt, 'full prompt must be reconstructed exactly');
  });

  it('CI-3: multi-line prompt preserves all \\n characters inside bracketed paste', () => {
    const lines = ['First line of instructions', 'Second line with details', 'Third line: constraints apply', 'Last line.'];
    const prompt = lines.join('\n');
    const { terminal, writes } = makeMockTerminal(prompt);

    injectPrompt(terminal);

    const reconstructed = reconstructContent(writes);
    assert.equal(reconstructed, prompt, 'multi-line content must be reconstructed exactly');
    const newlineCount = (reconstructed.match(/\n/g) ?? []).length;
    assert.equal(newlineCount, lines.length - 1, 'all \\n characters must be preserved');
  });

  it('CI-4: Unicode content (emoji, multibyte, RTL) passes through sanitizePrompt intact', () => {
    const prompt = 'Hello 🎉 — Unicode: 日本語テスト — emoji: 🚀🔥 — Arabic: مرحبا';
    const { terminal, writes } = makeMockTerminal(prompt);

    injectPrompt(terminal);

    const reconstructed = reconstructContent(writes);
    assert.equal(reconstructed, prompt, 'Unicode content must not be corrupted by sanitizePrompt');
  });

  it('CI-5: prompt consisting entirely of ANSI sequences → no ptyProcess.write() called', () => {
    // sanitizePrompt strips all ANSI control sequences; if the result is empty, no write must occur
    const prompt = '\x1b[?1;2c\x1b]10;rgb:ff/ff/ff\x07\x1b[>0;276;0c';
    const { terminal, writes } = makeMockTerminal(prompt);

    injectPrompt(terminal);

    assert.equal(writes.length, 0, 'no ptyProcess.write() must be called when prompt is empty after sanitization');
    assert.equal(terminal._pendingPrompt, null, '_pendingPrompt must be cleared regardless');
  });
});
