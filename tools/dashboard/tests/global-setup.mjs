import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { killStalePids, BASE_PORT } from './server-utils.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

export const SPEC_FILES = [
  'regression',
  'scroll-behavior',
  'scroll-wheel',
  'cursor-scroll-independence',
  'terminal-experience',
  'panel-lifecycle',
  'modal-lifecycle',
  'routing',
  'work-item-flow',
  'api-contracts',
  'error-paths',
  'restart-recovery',
  'org-dispatch',
  'dispatch-scroll',
  'auto-dismiss',
  'theme-system',
  'markdown-descriptions',
  'agent-phase',
  'text-selection',
  'worktree-dispatch',
  'dispatch-contract',
  'time-tracking',
  'time-report-dates',
  'suspend-resume',
  'state-transitions',
  'auto-implement',
  'worktree-readiness',
  'approvals',
  'work-item-flags',
  'build-tree',
  'autonomous-pipeline',
  'sidebar-fold',
  'notes-sidebar',
  'copy-fix',
  'terminal-grid',
  'modal-layout',
  'portfolio-persistence',
  'dispatch-mandate',
  'agent-phase-persist',
  'detach.contract',
  'org-repos.contract',
  'sessions-page',
  'cost-anomaly',
  'auto-timeout',
  'refinement',
  'task-creation',
  'project-refinement',
  'refine-terminal',
  'waiting-state',
  'date-columns',
  'costs',
  'prompt-history',
  'assets',
  'costs-summary',
  'terminal-project-filter',
  'sanitisation',
  'pty-resize',
  'fmt-timestamp',
  'date-filter',
  'prompt-preview.contract',
  'prompt-preview',
  'work-item-assets',
  'heartbeat',
  'progress-events',
  'dispatch-monitor',
  'drift-detection',
  'portfolio-audit.contract',
  'terminal-goal-summary',
  'session-end-fix',
  'terminal-notes',
  'project-key-filter',
  'work-items-filter',
  'dispatch-lifecycle',
  'review-checkboxes',
  'terminal-db-resilience',
];

function getLiveDashboardPorts() {
  const ports = new Set();
  if (process.env.PORT) ports.add(Number(process.env.PORT));
  try {
    const pidFile = join(ROOT, 'tmp', 'dashboard.pid');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const out = execFileSync('lsof', ['-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
    const match = out.match(/:(\d+) \(LISTEN\)/);
    if (match) ports.add(Number(match[1]));
  } catch {}
  if (ports.size === 0) ports.add(3777);
  return ports;
}

export default async function globalSetup() {
  const livePorts = getLiveDashboardPorts();

  // Kill zombies from any prior run
  killStalePids();

  // Check for port collisions with the live dashboard
  for (let i = 0; i < SPEC_FILES.length; i++) {
    const port = BASE_PORT + i;
    if (livePorts.has(port)) {
      throw new Error(`Test port ${port} (${SPEC_FILES[i]}) collides with live dashboard. Live dashboard ports: ${[...livePorts].join(', ')}`);
    }
  }

  // Servers are started lazily per-worker in fixtures.mjs — no upfront spawning.
}
