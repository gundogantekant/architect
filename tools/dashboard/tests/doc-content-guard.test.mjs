/**
 * Unit tests for validateDocContent — the content integrity guard that rejects
 * one-char-per-line corrupted documentation (W-1264).
 *
 * Root cause: tracker agent's inline curl -d pattern embeds multi-line content
 * directly in a shell single-quoted string. If an LLM substitutes real markdown
 * with newlines, the JSON body is either malformed (silent write failure) or
 * the content arrives character-by-character. The guard makes corruption visible
 * as a 422 error rather than silently storing bad data.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocContent } from '../routes/work-items.mjs';

describe('validateDocContent', () => {
  it('returns the content unchanged for normal multi-paragraph text', () => {
    const normal =
      '# Architecture Guide\n\n' +
      'This is paragraph one with a proper sentence.\n\n' +
      'This is paragraph two.\n\n' +
      'This is paragraph three with more content.';
    assert.strictEqual(validateDocContent(normal), normal);
  });

  it('returns short content unchanged regardless of single-char ratio (< 20 lines threshold)', () => {
    // 8 lines, 6 are single alpha — 75% ratio, but < 20 lines → no rejection
    const fence = '```\na\nb\nc\nd\ne\nf\n```';
    assert.strictEqual(validateDocContent(fence), fence);
  });

  it('does NOT reject markdown with valid single-symbol lines (>, -, *, #)', () => {
    // Symbols are NOT counted by /^[a-zA-Z]$/ — only alpha chars trigger the check
    const lines = [];
    for (let i = 0; i < 25; i++) {
      lines.push(i % 3 === 0 ? '>' : i % 3 === 1 ? '-' : 'A full sentence with several words here.');
    }
    const validMarkdown = lines.join('\n');
    assert.doesNotThrow(() => validateDocContent(validMarkdown));
  });

  it('rejects one-char-per-line content (26 alpha lines, 100% ratio)', () => {
    const corrupted = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\nv\nw\nx\ny\nz';
    const e = assert.throws(
      () => validateDocContent(corrupted),
      (err) => {
        assert.match(err.message, /integrity check failed/);
        assert.strictEqual(err.status, 422);
        return true;
      }
    );
    void e;
  });

  it('rejects content where > 50% of 20+ lines are single alpha characters', () => {
    // 21 lines: 15 single alpha (71%), 6 normal sentences
    const lines = [];
    for (let i = 0; i < 21; i++) {
      lines.push(i < 15 ? String.fromCharCode(97 + (i % 26)) : 'Normal sentence here.');
    }
    assert.throws(() => validateDocContent(lines.join('\n')), /integrity check failed/);
  });

  it('rejects non-string content with status 400', () => {
    for (const bad of [null, undefined, 42, ['a', 'b'], { content: 'hi' }]) {
      const e = assert.throws(
        () => validateDocContent(bad),
        (err) => {
          assert.match(err.message, /must be a string/);
          assert.strictEqual(err.status, 400);
          return true;
        }
      );
      void e;
    }
  });

  it('accepts content with exactly 50% single-alpha lines (ratio boundary — not rejected)', () => {
    // Exactly 50% does NOT exceed the > 0.5 threshold (>= 20 lines, ratio check fires but passes)
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(i < 10 ? String.fromCharCode(97 + i) : 'Full sentence with words.');
    }
    assert.doesNotThrow(() => validateDocContent(lines.join('\n')));
  });

  it('rejects content with exactly 20 lines when > 50% are single alpha (>= 20 line boundary)', () => {
    // Exactly 20 lines: 15 single alpha (75%) → rejected because >= 20 applies
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(i < 15 ? String.fromCharCode(97 + i) : 'Normal sentence with several words here.');
    }
    assert.throws(() => validateDocContent(lines.join('\n')), /integrity check failed/);
  });

  it('does NOT reject content under 20 lines regardless of ratio (< 20 threshold)', () => {
    // 8 lines, 6 are single alpha — 75% ratio, but 8 < 20 → no rejection
    const fence = '```\na\nb\nc\nd\ne\nf\n```';
    assert.strictEqual(validateDocContent(fence), fence);
  });
});
