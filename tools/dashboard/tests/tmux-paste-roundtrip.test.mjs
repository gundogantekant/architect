/**
 * REAL-tmux regression test for utils.mjs `tmuxPasteStdin`.
 *
 * Why this exists (and why the mocked suite cannot replace it):
 *   `tmuxPasteStdin` originally ran
 *     execFileAsync('tmux', [...,'load-buffer','-'], { input: text })
 *   but promisify(execFile) IGNORES the `input` option (only execFileSync /
 *   spawnSync honour it), so `load-buffer -` blocked forever on an unwritten
 *   stdin → the whole inject path hung. The unit/integration tests stub the
 *   tmux helpers, so they could not see this. The fix feeds the child's stdin
 *   via `child.stdin.end(text)`. This test drives a REAL tmux server end to end
 *   so the regression surfaces as a timeout failure rather than an infinite
 *   hang in CI.
 *
 * On a tmux-less machine the test SKIPS (never fails).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { tmuxPasteStdin } from '../utils.mjs';
import { TMUX_AVAILABLE } from '../constants.mjs';

// Unique, deterministic-but-collision-resistant session name. Avoids Math.random;
// derives from pid + high-resolution time so concurrent CI runs don't clash.
const SESSION = `arch-test-paste-${process.pid}-${process.hrtime.bigint()}`;
const BUFFER = `arch-${SESSION}`;

const CANARIES = ['LINE-ONE-CANARY', 'LINE-TWO-CANARY', 'LINE-THREE-CANARY'];

function tmux(args) {
  return execFileSync('tmux', args, { encoding: 'utf8' });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('tmuxPasteStdin real-tmux round-trip', () => {
  it(
    'delivers multi-line text into a pane without hanging',
    { skip: TMUX_AVAILABLE ? false : 'tmux not available', timeout: 8000 },
    async () => {
      // `cat` echoes whatever is pasted (after the -d flush) back into the pane.
      tmux(['new-session', '-d', '-s', SESSION, '-x', '80', '-y', '24', 'cat']);

      try {
        // If the stdin-feed regression returns, load-buffer never resolves and the
        // 8s per-test timeout fails the test (instead of hanging forever).
        await tmuxPasteStdin(SESSION, CANARIES.join('\n'));

        // Give the pane a moment to render the pasted/echoed lines.
        await sleep(400);

        const pane = tmux(['capture-pane', '-t', SESSION, '-p']);

        // All three canaries present proves: stdin feed worked → buffer non-empty
        // → paste delivered, AND `-r` kept the lines distinct rather than
        // collapsing every LF into a single CR.
        for (const canary of CANARIES) {
          assert.ok(
            pane.includes(canary),
            `expected pasted canary "${canary}" in captured pane, got:\n${pane}`,
          );
        }
      } finally {
        // Never leak throwaway sessions or buffers.
        try { tmux(['kill-session', '-t', SESSION]); } catch {}
        try { tmux(['delete-buffer', '-b', BUFFER]); } catch {}
      }
    },
  );
});
