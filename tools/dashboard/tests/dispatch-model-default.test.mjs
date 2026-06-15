import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDispatchModelDefault, ARCHITECT_CANONICAL_KEY } from '../db.mjs';
import { ARCHITECT_KEY } from '../constants.mjs';
import { validateModel } from '../utils.mjs';

/**
 * Default dispatch MODEL resolution + [1m]-suffix-aware validateModel unit tests.
 *
 * Pure, node --test, no server. Mirrors plan-execute.test.mjs (the mode resolver).
 * Operates on in-memory prefs snapshots only — never the shared dashboard DB.
 */

// ── 1. resolveDispatchModelDefault precedence + architect normalization ──────

describe('DM-default: resolveDispatchModelDefault precedence and architect normalization', () => {
  const prefs = {
    default_dispatch_model: 'sonnet',
    'default_dispatch_model:ticari/architect/main': 'claude-opus-4-8[1m]',
  };

  it('per-project override wins for the canonical architect key', () => {
    assert.equal(resolveDispatchModelDefault(ARCHITECT_CANONICAL_KEY, prefs), 'claude-opus-4-8[1m]');
  });

  it('en-dash ARCHITECT_KEY normalizes to canonical → Opus 1M', () => {
    assert.equal(resolveDispatchModelDefault(ARCHITECT_KEY, prefs), 'claude-opus-4-8[1m]');
  });

  it('a non-architect project falls back to the global default', () => {
    assert.equal(resolveDispatchModelDefault('some/other/comp', prefs), 'sonnet');
  });

  it('null/missing project key falls back to the global default', () => {
    assert.equal(resolveDispatchModelDefault(null, prefs), 'sonnet');
  });

  it('with no prefs at all, falls back to sonnet (safe default)', () => {
    assert.equal(resolveDispatchModelDefault('some/other/comp', {}), 'sonnet');
    assert.equal(resolveDispatchModelDefault(ARCHITECT_KEY, {}), 'sonnet');
  });
});

// ── 2. validateModel [1m]-suffix handling ────────────────────────────────────

describe('DM-suffix: validateModel splits/re-appends an optional [1m] suffix', () => {
  it('alias + suffix resolves the base and keeps the suffix', () => {
    assert.equal(validateModel('opus[1m]'), 'claude-opus-4-8[1m]');
  });

  it('an already-resolved id with suffix passes through unchanged', () => {
    assert.equal(validateModel('claude-opus-4-8[1m]'), 'claude-opus-4-8[1m]');
  });

  it('a plain alias (no suffix) resolves with no suffix appended', () => {
    assert.equal(validateModel('sonnet'), 'claude-sonnet-4-6');
  });

  it('empty / junk falls back to sonnet (no suffix)', () => {
    assert.equal(validateModel(''), 'claude-sonnet-4-6');
    assert.equal(validateModel('garbage'), 'claude-sonnet-4-6');
  });
});
