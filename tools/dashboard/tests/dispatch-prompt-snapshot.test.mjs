/**
 * Dispatch prompt golden-output snapshot test — W-1196
 *
 * Exercises every conditional branch of buildDispatchPrompt() against committed
 * golden output. CI exits 1 on any non-empty diff, blocking merges.
 *
 * Run: node tools/dashboard/tests/dispatch-prompt-snapshot.test.mjs
 *
 * To regenerate the golden file (e.g. after intentional prompt changes):
 *   REGEN=1 node tools/dashboard/tests/dispatch-prompt-snapshot.test.mjs
 *
 * No DB or server required — all fixtures are hard-coded objects.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../constants.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const GOLDEN_FILE = join(__dir, 'snapshots', 'dispatch-prompt-golden.txt');
const REGEN = process.env.REGEN === '1';

const FIXED_TS = new Date('2026-05-25T12:00:00Z').getTime();
const normalize = (str) => str.replaceAll(ROOT, '<ROOT>');

// Dynamic import so the module loads only after all statics are defined.
const { buildDispatchPrompt } = await import('../prompt-builder.mjs');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WORK_ITEM = {
  id: 'W-999',
  title: 'Test work item',
  status: 'planned',
  priority: 'high',
  tags: ['backend', 'api'],
  depends_on: ['W-100'],
  description: 'Implement test feature per spec.',
  session_log: [
    { date: '2026-01-01', summary: 'Initial investigation complete.' },
  ],
};

const EPIC = {
  id: 'E-10',
  title: 'Test epic',
  status: 'active',
  progress: '3/7',
  acceptance_criteria: 'All items done and tested.',
  items: [
    { id: 'W-999', status: 'planned', project_key: 'org/proj/main', title: 'Test work item' },
  ],
  plan_snippet: 'Step 1: implement. Step 2: test.',
};

const PORTFOLIO = {
  entry: {
    guidance: {
      stack_summary: 'Node.js, PostgreSQL',
      structure: ['src/ — source code', 'tests/ — test suite'],
      conventions: ['Use async/await', 'PascalCase for classes'],
      ci_cd: ['GitHub Actions on push to main'],
      testing: ['Playwright for E2E', 'Node test runner for unit'],
    },
    agents: {
      dispatch_notes: { coder: 'Always run tests after changes' },
    },
    brief: {
      purpose: 'SDLC automation system',
      domain: 'Developer tooling',
      users: 'Internal engineering team',
      key_entities: ['WorkItem', 'Dispatch', 'Portfolio'],
      architecture_rationale: 'Clean Architecture for maintainability',
      constraints: ['Must support offline mode'],
      environments: ['local', 'staging'],
      external_dependencies: ['PostgreSQL 16+', 'Claude API'],
    },
    custom_rules: ['Never commit secrets', 'All PRs require review'],
    doc_paths: ['docs/architecture.md'],
  },
  org: {
    conventions: { branch_prefix: 'feature/', pr_title_pattern: 'feat: ...' },
    rules: ['No force-push to main'],
    coding_standards: {
      additional_rules: ['Max function length 50 lines'],
      framework_patterns: { node: ['Use ES modules', 'Prefer async iterators'] },
    },
  },
  guides: [
    { filename: 'guide.md', content: '# Guide\n\nFollow these patterns.' },
  ],
  syncContext: {
    adrs: [
      {
        id: 'ADR-001',
        title: 'Use PostgreSQL',
        status: 'accepted',
        date: '2026-01-15',
        decision: 'Use PostgreSQL for persistence.',
        consequences: 'Requires Docker for local dev.',
      },
    ],
    recentChanges: [
      {
        commit_hash: 'abc12345',
        classification: 'feature',
        committed_at: '2026-05-01T10:00:00Z',
        ai_summary: 'Added date filter to work items view',
        affected_files: ['routes/work-items.mjs'],
        commit_message: 'feat: add date filter',
      },
    ],
    lastSyncedAt: '2026-05-21T00:00:00Z',
  },
};

const RELATED_PROJECTS = [
  {
    key: 'org/other/main',
    entry: {
      guidance: { stack_summary: 'Flutter, Dart' },
      brief: { purpose: 'Mobile client app' },
    },
  },
];

const WORKTREE_CONTEXT = {
  worktreePath: '/tmp/project-W-999-branch',
  branchName: 'feature-W-999-branch',
  sourceBranch: 'main',
};

const CONTRACT = {
  goal: 'Implement the feature as specified.',
  constraints: 'Must not break existing tests.',
  expected_output: 'New endpoint responding with 200.',
  failure_conditions: 'Tests fail or endpoint missing.',
  scope_boundary: 'src/routes/ only',
  stop_conditions: ['Tests fail', 'Out of scope changes detected'],
  e2e_test_criteria: ['GET /api/test returns 200', 'POST /api/test creates record'],
};

const ORG_CONTEXT = {
  org: {
    name: 'TestOrg',
    path_root: '/projects/testorg',
    conventions: { branch_prefix: 'feature/', pr_title_pattern: 'feat(scope): desc' },
    rules: ['Code review required for all PRs'],
    cloud_environments: {
      dev: { account_id: '123456789', profile: 'dev', region: 'us-east-1' },
    },
    coding_standards: {
      additional_rules: ['Use TypeScript strict mode'],
      framework_patterns: { react: ['Prefer function components'] },
    },
    design_systems: {
      tailwind: { type: 'css-framework', description: 'Utility-first CSS', depends_on: ['web-app'] },
    },
  },
  projectMap: [
    { name: 'api', role: 'backend', stack: 'Node.js', purpose: 'REST API service' },
    { name: 'web', role: 'frontend', stack: 'React', purpose: 'Web dashboard' },
  ],
};

// ── Build fixtures ────────────────────────────────────────────────────────────

async function runFixture(label, args) {
  const result = await buildDispatchPrompt(args);
  return `=== FIXTURE: ${label} ===\n\n${result}`;
}

const _origNow = Date.now;
Date.now = () => FIXED_TS;

const fixtureResults = await Promise.all([
  runFixture('full', {
    workItem: WORK_ITEM,
    projectKey: 'org/proj/main',
    projectPath: '/projects/proj',
    additionalInstructions: 'Focus on the auth module.',
    portfolio: PORTFOLIO,
    epicContext: EPIC,
    relatedProjects: RELATED_PROJECTS,
    worktreeContext: WORKTREE_CONTEXT,
    contract: CONTRACT,
  }),
  runFixture('minimal', {
    workItem: null,
    projectKey: 'org/proj/main',
    projectPath: '/projects/proj',
    additionalInstructions: 'Review the codebase.',
    portfolio: null,
    epicContext: null,
    relatedProjects: null,
    worktreeContext: null,
    contract: null,
  }),
  runFixture('org-context', {
    workItem: null,
    projectKey: 'org/*',
    projectPath: '/projects/testorg',
    additionalInstructions: 'Audit all projects.',
    portfolio: null,
    epicContext: null,
    orgContext: ORG_CONTEXT,
    relatedProjects: null,
    worktreeContext: null,
    contract: null,
  }),
  runFixture('workitem-no-epic', {
    workItem: WORK_ITEM,
    projectKey: 'org/proj/main',
    projectPath: '/projects/proj',
    additionalInstructions: null,
    portfolio: { entry: PORTFOLIO.entry, org: PORTFOLIO.org },
    epicContext: null,
    relatedProjects: null,
    worktreeContext: null,
    contract: null,
  }),
]);

Date.now = _origNow;

const combined = normalize(fixtureResults.join('\n\n' + '='.repeat(80) + '\n\n'));

// ── Regen or compare ──────────────────────────────────────────────────────────

if (REGEN) {
  mkdirSync(dirname(GOLDEN_FILE), { recursive: true });
  writeFileSync(GOLDEN_FILE, combined, 'utf8');
  console.log('Golden file regenerated:', GOLDEN_FILE);
  process.exit(0);
}

if (!existsSync(GOLDEN_FILE)) {
  console.error('Golden file not found:', GOLDEN_FILE);
  console.error('Run with REGEN=1 to generate it first.');
  process.exit(1);
}

const golden = readFileSync(GOLDEN_FILE, 'utf8');

if (combined === golden) {
  console.log('Snapshot test PASSED — output matches golden file.');
  process.exit(0);
} else {
  console.error('Snapshot test FAILED — output differs from golden file.');
  // Show first difference location
  const minLen = Math.min(combined.length, golden.length);
  let diffIdx = -1;
  for (let i = 0; i < minLen; i++) {
    if (combined[i] !== golden[i]) { diffIdx = i; break; }
  }
  if (diffIdx >= 0) {
    const context = 120;
    const start = Math.max(0, diffIdx - 40);
    console.error(`First diff at char ${diffIdx}:`);
    console.error('  Current: ', JSON.stringify(combined.slice(start, diffIdx + context)));
    console.error('  Golden:  ', JSON.stringify(golden.slice(start, diffIdx + context)));
  } else {
    console.error(`Length mismatch: current=${combined.length}, golden=${golden.length}`);
  }
  process.exit(1);
}
