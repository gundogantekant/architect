import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// --- Mock xterm buffer + terminal for testing fitPreservingScroll ---

function createMockTerm({ baseY = 100, viewportY = 100 } = {}) {
  let _viewportY = viewportY;
  let _baseY = baseY;
  return {
    get buffer() {
      return {
        active: {
          get baseY() { return _baseY; },
          get viewportY() { return _viewportY; },
        },
      };
    },
    scrollLines(delta) {
      _viewportY = Math.max(0, Math.min(_baseY, _viewportY + delta));
    },
    // Test helpers
    _setBaseY(v) { _baseY = v; },
    _setViewportY(v) { _viewportY = v; },
    _getViewportY() { return _viewportY; },
    _getBaseY() { return _baseY; },
  };
}

function createMockFitAddon(term, { newBaseY } = {}) {
  return {
    fit() {
      // Simulate reflow: baseY may change when columns change
      if (newBaseY !== undefined) {
        term._setBaseY(newBaseY);
      }
    },
  };
}

// --- Extract the function under test ---
// Original (buggy) implementation:
function fitPreservingScroll_ORIGINAL(term, fitAddon) {
  const buf = term.buffer.active;
  const scrollOffset = buf.baseY - buf.viewportY;
  fitAddon.fit();
  const newBuf = term.buffer.active;
  const targetY = Math.max(0, newBuf.baseY - scrollOffset);
  const delta = targetY - newBuf.viewportY;
  if (delta !== 0) term.scrollLines(delta);
}

// Fixed implementation: fractional positioning
function fitPreservingScroll_FIXED(term, fitAddon) {
  const buf = term.buffer.active;
  const wasAtBottom = buf.viewportY >= buf.baseY;

  // Record position as fraction of scrollable range
  const scrollFraction = buf.baseY > 0
    ? buf.viewportY / buf.baseY
    : 1;

  fitAddon.fit();

  const newBuf = term.buffer.active;

  if (wasAtBottom || newBuf.baseY === 0) {
    // Stay at bottom
    const delta = newBuf.baseY - newBuf.viewportY;
    if (delta !== 0) term.scrollLines(delta);
    return;
  }

  // Restore proportional position
  const targetY = Math.round(scrollFraction * newBuf.baseY);
  const clampedY = Math.max(0, Math.min(newBuf.baseY, targetY));
  const delta = clampedY - newBuf.viewportY;
  if (delta !== 0) term.scrollLines(delta);
}

// --- Dispatch log auto-scroll helper ---
function shouldAutoScroll(el) {
  return (el.scrollHeight - el.scrollTop - el.clientHeight) < 50;
}

// ============================================================
// Tests
// ============================================================

describe('fitPreservingScroll', () => {
  describe('original (buggy) — expected failures', () => {
    it('should preserve user position when scrolled up and baseY changes on reflow', () => {
      // User at line 50 out of 100 (scrolled halfway up)
      const term = createMockTerm({ baseY: 100, viewportY: 50 });
      // After fit, baseY changes to 120 (content reflow adds lines)
      const fitAddon = createMockFitAddon(term, { newBaseY: 120 });

      fitPreservingScroll_ORIGINAL(term, fitAddon);

      // Original preserves absolute offset (100-50=50 lines from bottom)
      // So targetY = 120-50 = 70. User was at 50% through content,
      // but now they're at 70/120 = 58%. Content region shifted.
      // The proportional approach would give 50/100 * 120 = 60.
      const viewportY = term._getViewportY();
      const baseY = term._getBaseY();
      const fraction = viewportY / baseY;

      // With absolute offset, fraction = 70/120 ≈ 0.583 — NOT 0.5
      // This test documents the bug: position drifts toward bottom on reflow
      assert.notEqual(Math.round(fraction * 100), 50,
        'Original drifts position — this documents the bug');
    });

    it('should drift position across refits with large baseY changes', () => {
      // User at 50% (viewportY=50, baseY=100)
      const term = createMockTerm({ baseY: 100, viewportY: 50 });

      // Simulate refits where baseY grows significantly (e.g. widening columns)
      // then shrinks back — absolute offset causes cumulative drift
      const baseYValues = [150, 80, 140, 70, 130];
      for (const newBase of baseYValues) {
        const fitAddon = createMockFitAddon(term, { newBaseY: newBase });
        fitPreservingScroll_ORIGINAL(term, fitAddon);
      }

      const finalFraction = term._getViewportY() / term._getBaseY();
      // Original: position drifts because absolute offset doesn't scale with baseY changes
      // Depending on sequence, drift may be upward or downward
      assert.notEqual(Math.round(finalFraction * 100), 50,
        'Original drifts across multiple refits with large baseY swings — documents the bug');
    });
  });

  describe('fixed — these must pass', () => {
    it('should stay at bottom when user was at bottom', () => {
      const term = createMockTerm({ baseY: 100, viewportY: 100 });
      const fitAddon = createMockFitAddon(term, { newBaseY: 120 });

      fitPreservingScroll_FIXED(term, fitAddon);

      assert.equal(term._getViewportY(), 120,
        'Should follow bottom when user was at bottom');
    });

    it('should preserve proportional position when scrolled up', () => {
      // User at 50% (viewportY=50, baseY=100)
      const term = createMockTerm({ baseY: 100, viewportY: 50 });
      const fitAddon = createMockFitAddon(term, { newBaseY: 120 });

      fitPreservingScroll_FIXED(term, fitAddon);

      // 50% of 120 = 60
      assert.equal(term._getViewportY(), 60,
        'Should maintain proportional scroll position');
    });

    it('should handle baseY shrinking on reflow', () => {
      const term = createMockTerm({ baseY: 100, viewportY: 50 });
      const fitAddon = createMockFitAddon(term, { newBaseY: 80 });

      fitPreservingScroll_FIXED(term, fitAddon);

      // 50% of 80 = 40
      assert.equal(term._getViewportY(), 40);
    });

    it('should handle baseY=0 (no scrollback)', () => {
      const term = createMockTerm({ baseY: 0, viewportY: 0 });
      const fitAddon = createMockFitAddon(term, { newBaseY: 0 });

      fitPreservingScroll_FIXED(term, fitAddon);

      assert.equal(term._getViewportY(), 0);
    });

    it('should handle user at top (viewportY=0)', () => {
      const term = createMockTerm({ baseY: 100, viewportY: 0 });
      const fitAddon = createMockFitAddon(term, { newBaseY: 120 });

      fitPreservingScroll_FIXED(term, fitAddon);

      // 0% of 120 = 0
      assert.equal(term._getViewportY(), 0,
        'Should stay at top when user was at top');
    });

    it('should be stable across multiple rapid refits', () => {
      const term = createMockTerm({ baseY: 100, viewportY: 50 });

      const baseYValues = [110, 95, 105, 100, 108];
      for (const newBase of baseYValues) {
        const fitAddon = createMockFitAddon(term, { newBaseY: newBase });
        fitPreservingScroll_FIXED(term, fitAddon);
      }

      const finalFraction = term._getViewportY() / term._getBaseY();
      // Should remain close to 50% — within 2% tolerance
      assert.ok(Math.abs(finalFraction - 0.5) <= 0.02,
        `Position should be stable near 50%, got ${(finalFraction * 100).toFixed(1)}%`);
    });

    it('should not scroll past baseY', () => {
      const term = createMockTerm({ baseY: 100, viewportY: 99 });
      const fitAddon = createMockFitAddon(term, { newBaseY: 50 });

      fitPreservingScroll_FIXED(term, fitAddon);

      assert.ok(term._getViewportY() <= 50);
    });
  });
});

describe('dispatch log auto-scroll', () => {
  function createMockLogEl({ scrollHeight, scrollTop, clientHeight }) {
    return { scrollHeight, scrollTop, clientHeight };
  }

  it('should auto-scroll when user is at bottom', () => {
    const el = createMockLogEl({ scrollHeight: 1000, scrollTop: 700, clientHeight: 300 });
    assert.ok(shouldAutoScroll(el), 'At bottom — should auto-scroll');
  });

  it('should auto-scroll when user is near bottom (within 50px)', () => {
    const el = createMockLogEl({ scrollHeight: 1000, scrollTop: 670, clientHeight: 300 });
    assert.ok(shouldAutoScroll(el), 'Near bottom — should auto-scroll');
  });

  it('should NOT auto-scroll when user has scrolled up significantly', () => {
    const el = createMockLogEl({ scrollHeight: 1000, scrollTop: 200, clientHeight: 300 });
    assert.ok(!shouldAutoScroll(el), 'Scrolled up — should NOT auto-scroll');
  });

  it('should NOT auto-scroll when user is at top', () => {
    const el = createMockLogEl({ scrollHeight: 1000, scrollTop: 0, clientHeight: 300 });
    assert.ok(!shouldAutoScroll(el), 'At top — should NOT auto-scroll');
  });
});
