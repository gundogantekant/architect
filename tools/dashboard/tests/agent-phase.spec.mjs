/**
 * Agent Phase Detection Tests
 *
 * Tests the derivePhase() pure function (unit) and the agent_phase API contract (integration).
 */

import { test, expect } from './fixtures.mjs';
import { api, seedDispatch } from './helpers.mjs';

// Import derivePhase directly for unit tests
import { derivePhase } from '../dispatch-manager.mjs';

test.describe('derivePhase unit tests @fast', () => {

  test('AP-1: content_block_start tool_use → tool_running', () => {
    const evt = { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } };
    expect(derivePhase('generating', evt)).toBe('tool_running');
  });

  test('AP-2: assistant end_turn → waiting_for_input', () => {
    const evt = { type: 'assistant', message: { stop_reason: 'end_turn' } };
    expect(derivePhase('generating', evt)).toBe('waiting_for_input');
  });

  test('AP-3: assistant tool_use → tool_running', () => {
    const evt = { type: 'assistant', message: { stop_reason: 'tool_use' } };
    expect(derivePhase('generating', evt)).toBe('tool_running');
  });

  test('AP-4: content_block_start text while tool_running → generating', () => {
    const evt = { type: 'content_block_start', content_block: { type: 'text' } };
    expect(derivePhase('tool_running', evt)).toBe('generating');
  });

  test('AP-5: content_block_delta text while tool_running → generating', () => {
    const evt = { type: 'content_block_delta', delta: { text: 'hello' } };
    expect(derivePhase('tool_running', evt)).toBe('generating');
  });

  test('AP-6: content_block_start text while generating → no change', () => {
    const evt = { type: 'content_block_start', content_block: { type: 'text' } };
    expect(derivePhase('generating', evt)).toBe('generating');
  });

  test('AP-7: result → null', () => {
    const evt = { type: 'result', total_cost_usd: 0.05 };
    expect(derivePhase('waiting_for_input', evt)).toBeNull();
    expect(derivePhase('generating', evt)).toBeNull();
    expect(derivePhase('tool_running', evt)).toBeNull();
  });

  test('AP-8: unknown event → no change', () => {
    const evt = { type: 'message_stop' };
    expect(derivePhase('generating', evt)).toBe('generating');
    expect(derivePhase('tool_running', evt)).toBe('tool_running');
    expect(derivePhase('waiting_for_input', evt)).toBe('waiting_for_input');
    expect(derivePhase(null, evt)).toBeNull();
  });

  test('AP-9: null initial phase with init event → no change', () => {
    const evt = { type: 'system', session_id: 'abc-123' };
    expect(derivePhase(null, evt)).toBeNull();
  });

  test('AP-10: rapid tool chain sequence', () => {
    let phase = 'generating';
    // tool call 1
    phase = derivePhase(phase, { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } });
    expect(phase).toBe('tool_running');
    // assistant says tool_use (more tools coming)
    phase = derivePhase(phase, { type: 'assistant', message: { stop_reason: 'tool_use' } });
    expect(phase).toBe('tool_running');
    // text response starts
    phase = derivePhase(phase, { type: 'content_block_start', content_block: { type: 'text' } });
    expect(phase).toBe('generating');
    // tool call 2
    phase = derivePhase(phase, { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Edit' } });
    expect(phase).toBe('tool_running');
    // text again
    phase = derivePhase(phase, { type: 'content_block_delta', delta: { text: 'Done.' } });
    expect(phase).toBe('generating');
  });

  test('AP-11: content_block_start tool_use from any state', () => {
    const evt = { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } };
    expect(derivePhase('generating', evt)).toBe('tool_running');
    expect(derivePhase('waiting_for_input', evt)).toBe('tool_running');
    expect(derivePhase('tool_running', evt)).toBe('tool_running');
    expect(derivePhase(null, evt)).toBe('tool_running');
  });
});

test.describe('agent_phase API contract @fast', () => {

  test('AP-20: dispatch/active returns agent_phase and derived needs_input', async () => {
    const { dispatch_id } = await seedDispatch({ status: 'running' });
    const list = await api('dispatch/active');
    const running = list.find(d => d.id === dispatch_id);
    expect(running).toBeDefined();
    expect(running).toHaveProperty('agent_phase');
    expect(running).toHaveProperty('needs_input');
    expect(typeof running.needs_input).toBe('boolean');
  });

  test('AP-21: needs_input is derived from agent_phase', async () => {
    await seedDispatch({ status: 'running' });
    const list = await api('dispatch/active');
    for (const d of list) {
      expect(d.needs_input).toBe(d.agent_phase === 'waiting_for_input');
    }
  });

  test('AP-22: completed dispatch has null agent_phase', async () => {
    const { dispatch_id } = await seedDispatch({ status: 'completed' });
    const list = await api('dispatch/active');
    const completed = list.find(d => d.id === dispatch_id);
    expect(completed).toBeDefined();
    expect(completed.agent_phase).toBeNull();
  });
});
