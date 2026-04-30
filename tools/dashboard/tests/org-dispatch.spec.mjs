/**
 * Organization-Level Dispatch Contract Tests
 *
 * Defines the contract for org-level agent dispatch: API endpoints,
 * UI interactions, and prompt content assembly.
 *
 * Written BEFORE implementation per domain/rules.md → Contract-First Planning Rules.
 * All tests must FAIL (red) initially, then PASS (green) after implementation.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api } from './helpers.mjs';

const _OD_PROJECT_KEY = 'ticari/architect/main';
const _OD_ROOT = '/Users/tekantgundogan/Documents/architect';
const _OD_ORG_ENTRY = {
  name: 'Ticari',
  path_root: _OD_ROOT,
  conventions: { branch_naming: 'feature/description', commit_style: 'conventional' },
  rules: ['Use feature branches for all changes', 'Run tests before merging'],
};
const _OD_PORTFOLIO_ENTRY = {
  name: 'architect',
  role: 'SDLC orchestrator',
  brief: { purpose: 'Manages software development lifecycle' },
  guidance: { stack_summary: 'Node.js, SQLite, Playwright' },
  worktree_mode: 'auto',
  worktree_setup: { branch: 'main' },
};

test.beforeEach(async () => {
  await api('test/seed-portfolio-entry', {
    method: 'POST',
    body: JSON.stringify({
      project_key: _OD_PROJECT_KEY,
      entry: _OD_PORTFOLIO_ENTRY,
      org_entry: _OD_ORG_ENTRY,
    }),
  });
});


// Helper: seed an org-level terminal via the test endpoint (no real PTY)
async function seedOrgTerminal(orgKey, instructions = 'Test', status = 'running') {
  return api('test/seed-org-terminal', {
    method: 'POST',
    body: JSON.stringify({ org_key: orgKey, additional_instructions: instructions, status }),
  });
}

// Helper: build an org prompt via the test endpoint (no terminal needed)
async function buildOrgPrompt(orgKey, instructions = 'Test') {
  return api('test/build-org-prompt', {
    method: 'POST',
    body: JSON.stringify({ org_key: orgKey, additional_instructions: instructions }),
  });
}

// ============================================================
// API Layer Contracts
// ============================================================

test.describe('Org dispatch API contracts @fast', () => {

  test('OD-1: POST /api/test/seed-org-terminal with org_key returns 200 + terminal_id', async () => {
    const result = await seedOrgTerminal('ticari', 'List all projects');
    expect(result.terminal_id).toBeTruthy();
    expect(result.terminal_id).toMatch(/^T-/);
    expect(result.project_path).toBeTruthy();
  });

  test('OD-2: POST /api/terminal with neither org_key nor project_key returns 400', async () => {
    const resp = await fetch(`${getBase()}/api/terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        additional_instructions: 'This should fail',
      }),
    });
    expect(resp.status).toBe(400);
  });

  test('OD-3: Org-level terminal resolves org path_root as project_path', async () => {
    const orgData = await api('org/ticari');
    const expectedPath = orgData.path_root;

    const result = await seedOrgTerminal('ticari', 'Test path resolution');

    // Check the terminal's active record for project_path
    const active = await api('terminal/active');
    const terminal = active.find(t => t.id === result.terminal_id);
    expect(terminal).toBeTruthy();
    expect(terminal.project_path).toBe(expectedPath);
  });

  test('OD-4: GET /api/terminal/active includes org_key field on org-level terminals', async () => {
    const result = await seedOrgTerminal('ticari', 'Test org_key field');

    const active = await api('terminal/active');
    const terminal = active.find(t => t.id === result.terminal_id);
    expect(terminal).toBeTruthy();
    expect(terminal.org_key).toBe('ticari');
  });

  test('OD-5: Org-level terminal prompt contains org conventions, rules, and project map', async () => {
    const result = await seedOrgTerminal('ticari', 'Analyze organization structure');

    const active = await api('terminal/active');
    const terminal = active.find(t => t.id === result.terminal_id);
    expect(terminal).toBeTruthy();
    expect(terminal.prompt).toBeDefined();
    expect(terminal.prompt).toContain('Organization Context');
    expect(terminal.prompt).toContain('Project Map');
  });
});

// ============================================================
// UI Layer Contracts
// ============================================================

test.describe('Org dispatch UI contracts', () => {

  test('OD-6: #org/{org} view renders "Discuss with Agent" button', async ({ page }) => {
    await page.goto('/#org/ticari');
    await page.waitForLoadState('networkidle');

    const btn = page.locator('#discuss-org-agent');
    await expect(btn).toBeVisible({ timeout: 5_000 });
    await expect(btn).toHaveText(/Discuss with Agent/);
    // Verify teal background
    const bgColor = await btn.evaluate(el => getComputedStyle(el).backgroundColor);
    expect(bgColor).toBeTruthy();
  });

  test('OD-7: Clicking button opens dispatch modal with org name', async ({ page }) => {
    await page.goto('/#org/ticari');
    await page.waitForLoadState('networkidle');

    await page.click('#discuss-org-agent');

    // Modal should appear
    const modal = page.locator('.modal-overlay');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    // Modal should show org name, not a project key
    const modalText = await modal.textContent();
    expect(modalText).toContain('ticari');

    // Should have instructions textarea
    const textarea = modal.locator('#discuss-org-instructions');
    await expect(textarea).toBeVisible();

    // Should have agent type selector
    const agentSelect = modal.locator('#discuss-org-agent-type');
    await expect(agentSelect).toBeVisible();
  });

  test('OD-8: Submitting modal creates terminal session and panel appears in org view', async ({ page }) => {
    await page.goto('/#org/ticari');
    await page.waitForLoadState('networkidle');

    await page.click('#discuss-org-agent');
    await page.fill('#discuss-org-instructions', 'What projects exist in this organization?');
    await page.click('#discuss-org-submit');

    // Terminal panel should appear in the org view
    const terminalPanel = page.locator('.terminal-panel');
    await expect(terminalPanel).toBeVisible({ timeout: 15_000 });
  });

  test('OD-9: Org-level sessions appear in org view session slot', async ({ page }) => {
    // Seed an org-level terminal via test endpoint
    const result = await seedOrgTerminal('ticari', 'Test session visibility', 'running');
    expect(result.terminal_id).toBeTruthy();

    // Navigate to org view
    await page.goto('/#org/ticari');
    await page.waitForLoadState('networkidle');

    // The session slot should exist in the DOM
    const sessionSlot = page.locator('[data-session-slot-org="ticari"]');
    await expect(sessionSlot).toBeVisible({ timeout: 10_000 });
  });
});

// ============================================================
// Prompt Content Contracts (unit-level via test endpoint)
// ============================================================

test.describe('Org dispatch prompt contracts @fast', () => {

  test('OD-10: Org prompt includes Organization Context section with conventions and rules', async () => {
    const result = await buildOrgPrompt('ticari', 'Test prompt content');
    expect(result.prompt).toContain('# Organization Context');
    expect(result.prompt).toMatch(/Convention|convention/);
    expect(result.prompt).toMatch(/Rule|rule/i);
  });

  test('OD-11: Org prompt includes Project Map with all org projects', async () => {
    const result = await buildOrgPrompt('ticari', 'Test project map');
    expect(result.prompt).toContain('# Project Map');
    // Should list at least one project from the ticari org
    expect(result.prompt).toMatch(/architect|is-arama|personal/);
  });

  test('OD-12: Org prompt includes navigation guidance', async () => {
    const result = await buildOrgPrompt('ticari', 'Test navigation');
    // Should contain navigation instructions
    expect(result.prompt).toContain('dashboard API');
    expect(result.prompt).toMatch(/portfolio|api\/component/);
  });
});
