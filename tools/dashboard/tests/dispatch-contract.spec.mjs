/**
 * Dispatch Contract Tests
 *
 * Headless tests — no browser required. Validates that buildDispatchPrompt
 * renders DispatchContract sections correctly and handles edge cases.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

const BASE_CONTRACT = {
  goal: 'Implement the auth middleware with JWT validation',
  constraints: 'No breaking changes to existing API routes',
  expected_output: 'Modified middleware file with passing test suite',
  failure_conditions: 'Any existing endpoint returns a different response shape',
};

test.describe('Dispatch Contract @fast', () => {

  test('DC-1: prompt-builder renders full contract section', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: { id: 'W-900', title: 'DC-1 test', status: 'open', priority: 'medium' },
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
        contract: BASE_CONTRACT,
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();

    expect(prompt).toContain('# Dispatch Contract');
    expect(prompt).toContain(`**Goal**: ${BASE_CONTRACT.goal}`);
    expect(prompt).toContain(`**Constraints**: ${BASE_CONTRACT.constraints}`);
    expect(prompt).toContain(`**Expected Output**: ${BASE_CONTRACT.expected_output}`);
    expect(prompt).toContain(`**Failure Conditions**: ${BASE_CONTRACT.failure_conditions}`);
  });

  test('DC-2: no contract section when contract is absent', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: { id: 'W-901', title: 'DC-2 test', status: 'open', priority: 'medium' },
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();

    expect(prompt).not.toContain('# Dispatch Contract');
  });

  test('DC-3: partial contract renders only non-empty fields', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: { id: 'W-902', title: 'DC-3 test', status: 'open', priority: 'medium' },
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
        contract: { goal: 'Fix the login bug', constraints: '', expected_output: '', failure_conditions: 'Login still fails' },
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();

    expect(prompt).toContain('# Dispatch Contract');
    expect(prompt).toContain('**Goal**: Fix the login bug');
    expect(prompt).toContain('**Failure Conditions**: Login still fails');
    expect(prompt).not.toContain('**Constraints**:');
    expect(prompt).not.toContain('**Expected Output**:');
  });

  test('DC-4: all-empty contract treated as absent', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: { id: 'W-903', title: 'DC-4 test', status: 'open', priority: 'medium' },
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
        contract: { goal: '', constraints: '', expected_output: '', failure_conditions: '' },
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();

    expect(prompt).not.toContain('# Dispatch Contract');
  });

  test('DC-5: contract section appears after Work Item, before Epic Context', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: { id: 'W-904', title: 'DC-5 test', status: 'open', priority: 'medium' },
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
        contract: BASE_CONTRACT,
        epicContext: { id: 'E-001', title: 'Test epic', status: 'active', progress: '0/1' },
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();

    const workItemIdx = prompt.indexOf('# Work Item');
    const contractIdx = prompt.indexOf('# Dispatch Contract');
    const epicIdx = prompt.indexOf('# Epic Context');

    expect(workItemIdx).toBeGreaterThan(-1);
    expect(contractIdx).toBeGreaterThan(workItemIdx);
    expect(epicIdx).toBeGreaterThan(contractIdx);
  });

  test('DC-6: dispatch instructions section renders correctly (renamed from Constraints)', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: { id: 'W-905', title: 'DC-6 test', status: 'open', priority: 'medium' },
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
        additionalInstructions: 'Focus on the auth module only',
        contract: BASE_CONTRACT,
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();

    expect(prompt).toContain('# Dispatch Instructions');
    expect(prompt).toContain('Focus on the auth module only');
    expect(prompt).not.toContain('# Constraints\n');
  });

});
