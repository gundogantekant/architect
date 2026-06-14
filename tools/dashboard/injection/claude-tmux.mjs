/**
 * Pure screen predicates for the tmux prompt-injection state machine.
 *
 * Input is the visible-pane text from `tmux capture-pane -p` (no SGR codes).
 * No I/O here — these are unit-testable against recorded captures and crafted
 * dialog/boot fixtures.
 */

// The composer affordance: a line containing the `❯` prompt arrow. Claude Code
// renders it mid-line — glued to the end of a horizontal-rule line (`────…❯ `)
// or inside a bordered box (`│ ❯ … │`) — not only at the start of a line. Its
// presence is a proxy for "Claude has mounted its Ink input and enabled
// bracketed paste (?2004h)", which is why a paste-buffer -p delivery lands here.
const COMPOSER_ARROW = '❯';

// Trust / login / update / selection prompts. Pasting into any of these would
// answer the dialog with prompt text, so they must never receive a paste.
const DIALOG_PATTERNS = [
  /do you trust/i,
  /select login method/i,
  /choose the text style/i,
  /\bsign in\b/i,
  /press enter to (?:continue|login)/i,
  /\bupdate available\b/i,
  /would you like to/i,
  /\b❯\s*\d+\.\s/, // arrow pointing at a numbered menu choice
  /^\s*\d+\.\s.+\n\s*\d+\.\s/m, // a numbered menu (two+ consecutive choices)
  /\(y\/n\)/i,
];

function nonBlankLines(capture) {
  return (capture || '').split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l !== '');
}

function hasComposer(capture) {
  return (capture || '').split('\n').some(l => l.includes(COMPOSER_ARROW));
}

function looksLikeDialog(capture) {
  return DIALOG_PATTERNS.some(re => re.test(capture || ''));
}

/**
 * Classify a captured Claude screen.
 * @param {string} capture - plain text from `tmux capture-pane -p`
 * @returns {'input'|'dialog'|'boot'}
 */
export function classifyClaudeScreen(capture) {
  if (looksLikeDialog(capture)) return 'dialog';
  if (hasComposer(capture)) return 'input';
  return 'boot';
}

// The composer region: the line containing `❯` and everything after it. We
// compare only this region so an animated spinner / clock / elapsed-timer line
// rendered ABOVE the input box does not prevent stabilization.
export function inputRegion(capture) {
  const lines = nonBlankLines(capture);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes(COMPOSER_ARROW)) {
      return lines.slice(i).join('\n');
    }
  }
  return null;
}

/**
 * Two consecutive captures whose composer regions are byte-identical are stable.
 * Returns false if either capture lacks a composer.
 * @returns {boolean}
 */
export function inputRegionStable(prevCap, curCap) {
  const prev = inputRegion(prevCap);
  const cur = inputRegion(curCap);
  if (prev === null || cur === null) return false;
  return prev === cur;
}
