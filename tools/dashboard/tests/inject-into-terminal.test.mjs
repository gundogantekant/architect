import { test } from 'node:test';
import assert from 'node:assert/strict';
import { injectIntoTerminal } from '../pty-manager.mjs';

test('rejects a non-running terminal without touching injectPrompt', async () => {
  const terminal = { status: 'completed' };
  const result = await injectIntoTerminal(terminal, 'hello');
  assert.deepEqual(result, { ok: false, reason: 'not_running' });
  assert.equal(terminal._pendingPrompt, undefined);
});

test('rejects a terminal with a pending prompt without touching injectPrompt', async () => {
  const terminal = { status: 'running', _pendingPrompt: 'x' };
  const result = await injectIntoTerminal(terminal, 'hello');
  assert.deepEqual(result, { ok: false, reason: 'busy' });
  assert.equal(terminal._pendingPrompt, 'x');
});
