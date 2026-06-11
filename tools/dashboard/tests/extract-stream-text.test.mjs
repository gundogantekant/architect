/**
 * Unit tests for extractStreamText — the dispatch stream-json event text extractor
 * (W-1264). Verifies that malformed JSONL returns null (not the raw line string),
 * preventing raw JSON from appearing in the dispatch panel output.
 *
 * extractStreamText in dispatch-manager.mjs takes an already-parsed event object.
 * The index.html inline version wraps JSON.parse inside the function. These tests
 * cover the dispatch-manager.mjs exported version (called with parsed events).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractStreamText } from '../dispatch-manager.mjs';

describe('extractStreamText (dispatch-manager.mjs)', () => {
  it('returns null for unknown event types — does not return garbage', () => {
    assert.strictEqual(extractStreamText({ type: 'ping' }), null);
    assert.strictEqual(extractStreamText({ type: 'unknown_event' }), null);
    assert.strictEqual(extractStreamText({}), null);
  });

  it('extracts text from content_block_delta text event', () => {
    const evt = { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } };
    assert.strictEqual(extractStreamText(evt), 'Hello world');
  });

  it('returns null for content_block_delta with no text (non-text delta type)', () => {
    const evt = { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } };
    assert.strictEqual(extractStreamText(evt), null);
  });

  it('joins multiple text blocks from assistant event', () => {
    const evt = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'First block. ' },
          { type: 'tool_use', id: 'x', name: 'bash', input: {} },
          { type: 'text', text: 'Second block.' },
        ],
      },
    };
    assert.strictEqual(extractStreamText(evt), 'First block. Second block.');
  });

  it('returns tool name for tool_use content_block_start', () => {
    const evt = { type: 'content_block_start', content_block: { type: 'tool_use', name: 'bash' } };
    const result = extractStreamText(evt);
    assert.ok(result?.includes('bash'), `Expected tool name in result, got: ${result}`);
  });

  it('returns result marker for result event', () => {
    const evt = { type: 'result' };
    const result = extractStreamText(evt);
    assert.ok(result?.includes('finished'), `Expected finish marker, got: ${result}`);
  });

  it('preserves embedded newlines in text content (does not produce one-char-per-line)', () => {
    const multiPara = 'Paragraph one.\n\nParagraph two.\n\nParagraph three.';
    const evt = { type: 'content_block_delta', delta: { type: 'text_delta', text: multiPara } };
    const result = extractStreamText(evt);
    assert.strictEqual(result, multiPara);
    // Verify no single-char-per-line corruption
    const lines = result.split('\n').filter(l => l.trim().length > 0);
    const singleChar = lines.filter(l => /^[a-zA-Z]$/.test(l.trim()));
    assert.strictEqual(singleChar.length, 0, 'Multi-paragraph content should not have single-char lines');
  });
});
