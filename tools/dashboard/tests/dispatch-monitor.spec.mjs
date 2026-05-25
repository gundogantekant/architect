/**
 * Dispatch Monitor Specification Tests (W-1205 Phase A)
 *
 * Pure unit tests that validate the orchestrator monitor loop logic
 * described in usecases/implement-work-item.md → Orchestrator Monitor Rules.
 *
 * These tests run without a browser or test server (no fixtures needed).
 * They document the expected behavior of the monitor loop.
 */

import { test, expect } from './fixtures.mjs';

// --- Monitor cursor logic ---

function bootstrapCursor(totalLines) {
  return Math.max(0, totalLines - 50);
}

function advanceCursor(previousTotal, newLinesCount) {
  return previousTotal + newLinesCount;
}

// --- Status classification ---

const TERMINAL_STATUSES = new Set(['done', 'failed', 'killed', 'interrupted']);

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function allTerminated(dispatches) {
  return dispatches.every(d => isTerminalStatus(d.status));
}

// --- Summary format ---

function buildMonitorSummary({ workItemId, timestamp, status, phase, lastLine, idleSince, action }) {
  return [
    `[Monitor ${workItemId}] ${timestamp}`,
    `Status    : ${status}`,
    `Phase     : ${phase}`,
    `Last line : ${lastLine}`,
    `Idle since: ${idleSince}`,
    `Action    : ${action}`,
  ].join('\n');
}

function resolveAction(workItemInputNeeded, dispatchStatus) {
  if (workItemInputNeeded) return 'input_needed — check dashboard';
  if (isTerminalStatus(dispatchStatus)) return 'done — ready to review';
  return 'none';
}

// --- Tests ---

test.describe('Dispatch Monitor Logic @fast', () => {

  test('DM-1: bootstrap cursor starts at max(totalLines - 50, 0)', () => {
    expect(bootstrapCursor(120)).toBe(70);
    expect(bootstrapCursor(30)).toBe(0);
    expect(bootstrapCursor(50)).toBe(0);
    expect(bootstrapCursor(51)).toBe(1);
    expect(bootstrapCursor(0)).toBe(0);
  });

  test('DM-2: cursor advances by the count of new lines received', () => {
    const previousTotal = 70;
    const newLinesCount = 5;
    expect(advanceCursor(previousTotal, newLinesCount)).toBe(75);
  });

  test('DM-3: input_needed dispatch sets Action to input_needed message', () => {
    const action = resolveAction(true, 'running');
    expect(action).toBe('input_needed — check dashboard');
  });

  test('DM-4: 5-line summary contains all required fields', () => {
    const summary = buildMonitorSummary({
      workItemId: 'W-1205',
      timestamp: '2026-05-25T10:00:00.000Z',
      status: 'running',
      phase: 'implementation',
      lastLine: 'Writing auth middleware...',
      idleSince: '2m 30s',
      action: 'none',
    });
    expect(summary).toContain('[Monitor W-1205]');
    expect(summary).toContain('Status    :');
    expect(summary).toContain('Phase     :');
    expect(summary).toContain('Last line :');
    expect(summary).toContain('Idle since:');
    expect(summary).toContain('Action    :');
    expect(summary.split('\n').length).toBe(6);
  });

  test('DM-5: loop ends when all monitored dispatches reach terminal status', () => {
    const running = [
      { status: 'running' },
      { status: 'done' },
    ];
    expect(allTerminated(running)).toBe(false);

    const allDone = [
      { status: 'done' },
      { status: 'failed' },
      { status: 'killed' },
      { status: 'interrupted' },
    ];
    expect(allTerminated(allDone)).toBe(true);
  });

});
