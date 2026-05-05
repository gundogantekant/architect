/**
 * Agent Phase Persistence Contract Tests (W-987)
 *
 * Headless tests — no browser required. Validates that agent_phase and
 * agent_phase_history are persisted to PostgreSQL and returned by the API.
 */

import { test, expect } from './fixtures.mjs';
import { api } from './helpers.mjs';

test.describe('Agent phase persistence @fast', () => {

  // AP-P1: agent_phase is returned from DB (not just in-memory) on active dispatch poll
  test('AP-P1: active dispatch includes agent_phase from DB', async () => {
    const id = `D-ap-p1-${Date.now()}`;

    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({ id, status: 'running', agent_phase: 'generating' }),
    });

    const dispatches = await api('dispatch/active');
    const d = dispatches.find(x => x.id === id);
    expect(d).toBeDefined();
    expect(d.agent_phase).toBe('generating');
  });

  // AP-P2: agent_phase_history is returned on active dispatch poll
  test('AP-P2: active dispatch includes agent_phase_history from DB', async () => {
    const id = `D-ap-p2-${Date.now()}`;
    const history = [
      { phase: 'generating', at: '2026-05-05T10:00:00.000Z' },
      { phase: 'tool_running', at: '2026-05-05T10:00:01.000Z' },
    ];

    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({ id, status: 'running', agent_phase: 'tool_running', agent_phase_history: history }),
    });

    const dispatches = await api('dispatch/active');
    const d = dispatches.find(x => x.id === id);
    expect(d).toBeDefined();
    expect(d.agent_phase_history).toHaveLength(2);
    expect(d.agent_phase_history[0].phase).toBe('generating');
  });

  // AP-P3: completed dispatch has agent_phase null in DB
  test('AP-P3: completed dispatch has agent_phase null', async () => {
    const id = `D-ap-p3-${Date.now()}`;

    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({ id, status: 'completed', agent_phase: null }),
    });

    const dispatches = await api('dispatch/active');
    const d = dispatches.find(x => x.id === id);
    expect(d).toBeDefined();
    expect(d.agent_phase).toBeNull();
  });

});
