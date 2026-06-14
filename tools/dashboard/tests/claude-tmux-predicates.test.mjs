/**
 * Unit tests for the pure tmux screen predicates.
 *
 * classifyClaudeScreen distinguishes the three states the injection state
 * machine branches on: 'input' (composer mounted, safe to paste), 'dialog'
 * (trust/login/menu — pasting would answer the prompt), 'boot' (still loading).
 *
 * inputRegionStable compares only the `❯` composer region so an animated
 * spinner/clock line rendered above the box does not block stabilization.
 *
 * Fixtures mirror real `tmux capture-pane -p` output (no SGR codes): the
 * input-ready screen is the Claude composer box with the `❯` arrow; the boot
 * splash is the pre-mount loading screen; the dialog is a crafted trust/select
 * menu (none was recorded, so it is synthesized from the patterns the
 * implementation guards against).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyClaudeScreen, inputRegionStable } from '../injection/claude-tmux.mjs';

// Real input-ready screen extracted from the recorded captures in
// tmp/dispatch-injection-test/*.events.json: the composer arrow is rendered
// at the end of a horizontal-rule line (`────…❯ `), not on a line of its own.
const RULE = '────────────────────────────────────────────────────────────────────────────────';
const INPUT_READY = [
  '  ▝▜█████▛▘ Haiku 4.5 · Claude Max',
  '   ▘▘ ▝▝ ~/Documents/architect',
  '',
  ' ⚠ 5 setup issues: MCP · /doctor',
  '',
  RULE + '❯ ',
  RULE + '➜  architect git:(tea-pot) Haiku 4.5 ⏵⏵ bypass permissions on',
].join('\n');

// The bare-arrow variant some renders show (arrow alone on its line).
const INPUT_READY_BARE_ARROW = [
  '  ✻ Welcome to Claude Code',
  '',
  '❯ ',
].join('\n');

const BOOT_SPLASH = [
  '',
  '  ✻ Claude Code starting…',
  '',
  '  Loading session and tools',
  '',
].join('\n');

const DIALOG_TRUST = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?                       │',
  '│                                                              │',
  '│ /Users/dev/Documents/architect                               │',
  '│                                                              │',
  '│ ❯ 1. Yes, proceed                                            │',
  '│   2. No, exit                                                │',
  '╰──────────────────────────────────────────────────────────────╯',
].join('\n');

const DIALOG_LOGIN = [
  'Select login method:',
  '',
  ' ❯ 1. Claude account with subscription',
  '   2. Anthropic Console account',
].join('\n');

describe('classifyClaudeScreen', () => {
  it('classifies the recorded composer-arrow screen as input', () => {
    assert.equal(classifyClaudeScreen(INPUT_READY), 'input');
  });

  it('classifies a bare-arrow composer line as input', () => {
    assert.equal(classifyClaudeScreen(INPUT_READY_BARE_ARROW), 'input');
  });

  it('classifies a trust dialog as dialog (never input)', () => {
    assert.equal(classifyClaudeScreen(DIALOG_TRUST), 'dialog');
  });

  it('classifies a login-method menu as dialog even though it contains an arrow', () => {
    assert.equal(classifyClaudeScreen(DIALOG_LOGIN), 'dialog');
  });

  it('classifies the pre-mount splash as boot', () => {
    assert.equal(classifyClaudeScreen(BOOT_SPLASH), 'boot');
  });

  it('classifies empty output as boot', () => {
    assert.equal(classifyClaudeScreen(''), 'boot');
  });
});

describe('inputRegionStable', () => {
  it('is stable when only a spinner/clock line above the box changes', () => {
    const tick1 = [
      '  ✶ Thinking… (12s · ↑ 1.2k tokens)',
      '',
      RULE + '❯ ',
    ].join('\n');
    const tick2 = [
      '  ✻ Thinking… (13s · ↑ 1.4k tokens)',
      '',
      RULE + '❯ ',
    ].join('\n');
    assert.equal(inputRegionStable(tick1, tick2), true);
  });

  it('is unstable when the composer region itself changes', () => {
    const tick1 = '❯ ';
    const tick2 = '❯ implement the';
    assert.equal(inputRegionStable(tick1, tick2), false);
  });

  it('is not ready when either capture lacks a composer', () => {
    assert.equal(inputRegionStable(BOOT_SPLASH, INPUT_READY), false);
    assert.equal(inputRegionStable(INPUT_READY, BOOT_SPLASH), false);
  });

  it('is not ready on two empty captures', () => {
    assert.equal(inputRegionStable('', ''), false);
  });
});
