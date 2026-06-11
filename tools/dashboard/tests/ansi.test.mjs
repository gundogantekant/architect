import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripAnsi } from '../lib/ansi.mjs';

test('empty string returns empty string', () => {
  assert.equal(stripAnsi(''), '');
});

test('plain text passes through unchanged', () => {
  assert.equal(stripAnsi('git status'), 'git status');
});

test('CSI sequence is stripped: DA primary response', () => {
  assert.equal(stripAnsi('\x1b[?1;2c'), '');
});

test('CSI sequence is stripped: DA secondary response', () => {
  assert.equal(stripAnsi('\x1b[>0;276;0c'), '');
});

test('CSI sequence is stripped: color reset', () => {
  assert.equal(stripAnsi('\x1b[0m'), '');
});

test('OSC sequence is stripped: foreground color query response (BEL terminator)', () => {
  assert.equal(stripAnsi('\x1b]10;rgb:1e1e/1e1e/2e2e\x07'), '');
});

test('OSC sequence is stripped: background color query response (ST terminator)', () => {
  assert.equal(stripAnsi('\x1b]11;rgb:f8f8/f8f8/f8f8\x1b\\'), '');
});

test('2-char ESC sequence is stripped', () => {
  assert.equal(stripAnsi('\x1bM'), '');  // ESC M = Reverse Index
});

test('lone ESC is stripped', () => {
  assert.equal(stripAnsi('\x1b'), '');
});

test('standalone BEL is stripped', () => {
  assert.equal(stripAnsi('\x07'), '');
});

test('standalone BS is stripped', () => {
  assert.equal(stripAnsi('\x08'), '');
});

test('mixed: DA responses + real command → only command remains', () => {
  const input = '\x1b[?1;2c\x1b[>0;276;0c\x1b]10;rgb:1e1e/1e1e/2e2e\x07git status';
  assert.equal(stripAnsi(input), 'git status');
});

test('\\r survives stripping', () => {
  assert.equal(stripAnsi('hello\r'), 'hello\r');
});

test('\\n survives stripping', () => {
  assert.equal(stripAnsi('hello\n'), 'hello\n');
});

test('\\r\\n survives stripping', () => {
  assert.equal(stripAnsi('git status\r\n'), 'git status\r\n');
});

test('realistic xterm.js startup sequence: all DA + OSC responses stripped', () => {
  const input = '\x1b[?1;2c\x1b[>0;276;0c\x1b]10;rgb:1e1e/1e1e/2e2e\x07\x1b]11;rgb:f8f8/f8f8/f8f8\x07';
  assert.equal(stripAnsi(input), '');
});
