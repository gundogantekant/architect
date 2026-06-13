import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const CLAUDE_BIN = (() => {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    console.warn('WARNING: "claude" binary not found in PATH. Terminal and dispatch features will fail.');
    return 'claude';
  }
})();

export const ROOT = resolve(import.meta.dirname, '..', '..');
export const LEGACY_PORTFOLIO = join(ROOT, 'portfolio');
export const PORTFOLIO = process.env.PORTFOLIO_DIR || join(homedir(), '.architect', 'portfolio');
export const WORK = process.env.WORK_DIR || join(ROOT, 'work');
export const LOGS_DIR = join(WORK, 'logs');
export const PROMPTS_DIR = process.env.PROMPTS_DIR || join(ROOT, 'tools', 'dashboard', 'prompts');
export const TRUNCATION_LIMIT = 100 * 1024; // 100 KB — same threshold as MAX_CONTENT_BYTES in assets.mjs
export const ARCHITECT_KEY = '\u2013/architect/\u2013';

export const port = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return 3777;
})();

// Resolve the address the server binds to. LAN-exposed by default (0.0.0.0) so the
// dashboard is reachable from other devices on the trusted LAN without per-host config,
// and survives DHCP/VPN IP changes. The dashboard has NO authentication and can dispatch
// agents / open terminals (effectively remote code execution), so the bind is paired with
// the Host/Origin access guard (lib/access-guard.mjs) and a startup no-auth warning.
// Opt out of LAN exposure with ARCHITECT_LOOPBACK_ONLY=1 or ARCHITECT_BIND_ALL=0, or pin
// a specific address with ARCHITECT_HOST. Exported as a pure function so the derivation
// can be unit-tested.
export function resolveBindHost(env = process.env) {
  if (env.ARCHITECT_HOST) return env.ARCHITECT_HOST;
  if (env.ARCHITECT_LOOPBACK_ONLY === '1') return '127.0.0.1';
  if (env.ARCHITECT_BIND_ALL === '0') return '127.0.0.1';
  return '0.0.0.0';
}

export const DEFAULT_HOST = resolveBindHost();

// Parse a comma-separated env list (allowed hosts / allowed IPs) into a trimmed,
// non-empty array. Consumed by the access guard (lib/access-guard.mjs) via server.mjs.
export function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// Access-guard configuration derived from the environment. ARCHITECT_ALLOWED_HOSTS is an
// allow-list of Host-header hostnames (in addition to loopback names + the server's own LAN
// IPs); ARCHITECT_ALLOW_IPS is an opt-in client-IP allow-list (empty = allow any non-blocked).
export function resolveAccessConfig(env = process.env) {
  return {
    allowedHosts: parseList(env.ARCHITECT_ALLOWED_HOSTS),
    allowIps: parseList(env.ARCHITECT_ALLOW_IPS),
  };
}

// Valid status values — canonical source: domain/entities.md and domain/rules.md
export const VALID_WORK_ITEM_STATUSES = new Set([
  'draft', 'planned', 'in-progress', 'blocked',
  'in-review', 'testing', 'preview',
  'done', 'cancelled', 'archived',
]);
export const VALID_EPIC_STATUSES = new Set(['draft', 'active', 'done', 'cancelled', 'archived']);
export const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);
export const VALID_APPROVAL_MODES = new Set(['all', 'any', 'sequential']);

// Statuses from which the orchestrator can pick up work and advance it.
// Includes `blocked` — a blocked item is "stuck but resumable", not terminal.
// Not enforced server-side for standard dispatch (human operators dispatch freely).
// Validated by contract test SM-19 and referenced by AI orchestrators.
export const DISPATCHABLE_STATUSES = Object.freeze(
  ['draft', 'planned', 'in-progress', 'blocked']
);

export const DISPATCH_MODES = Object.freeze(['standard', 'auto_implement', 'refinement', 'task_creation', 'project_refinement']);

// Subset for auto-implement (excludes `draft` — require human plan-gate first).
// Excludes `blocked` — humans block, humans unblock; automation must not bypass that contract.
export const AUTO_IMPLEMENTABLE_STATUSES = Object.freeze(
  ['planned', 'in-progress']
);

// Canonical state transition map. Mirrors domain/rules.md → State Transition Table.
// Contract test SM-17 enforces parity.
export const VALID_TRANSITIONS = new Map([
  ['draft',       new Set(['planned', 'cancelled'])],
  ['planned',     new Set(['in-progress', 'draft', 'cancelled'])],
  ['in-progress', new Set(['blocked', 'in-review', 'cancelled'])],
  ['blocked',     new Set(['in-progress', 'cancelled'])],
  ['in-review',   new Set(['in-progress', 'testing', 'cancelled'])],
  ['testing',     new Set(['in-progress', 'preview', 'cancelled'])],
  ['preview',     new Set(['in-progress', 'done', 'cancelled'])],
  ['done',        new Set(['archived', 'cancelled'])],
  ['cancelled',   new Set(['draft', 'archived'])],
  ['archived',    new Set([])],
]);

// Backward transitions bypass flag blocking (plus → cancelled and → archived).
export const BACKWARD_TRANSITIONS = new Set([
  'in-review->in-progress',
  'testing->in-progress',
  'preview->in-progress',
  'blocked->in-progress',
  'cancelled->draft',
]);

// T1 fast path shortcut: items tagged T1 may take in-progress→done directly.
export const T1_FAST_PATH_TRANSITIONS = new Set(['in-progress->done']);

// Stakeholder projection — simplified status labels for non-technical consumers.
export const STAKEHOLDER_PROJECTION = new Map([
  ['draft', 'Requested'],
  ['planned', 'Requested'],
  ['in-progress', 'In Progress'],
  ['blocked', 'In Progress'],
  ['in-review', 'In Review'],
  ['testing', 'In Review'],
  ['preview', 'In Review'],
  ['done', 'Done'],
  ['cancelled', 'Cancelled'],
  ['archived', 'Archived'],
]);

export function formatStatusWithFlags(item, view = 'internal') {
  const base = view === 'stakeholder'
    ? (STAKEHOLDER_PROJECTION.get(item.status) || item.status)
    : item.status;
  const flags = [];
  if (item.input_needed) flags.push('input needed');
  if (item.approval && item.approval.active) flags.push('approval needed');
  return flags.length ? `${base} [${flags.join(', ')}]` : base;
}

export function isBackwardTransition(from, to) {
  return BACKWARD_TRANSITIONS.has(`${from}->${to}`);
}

export function isAdministrativeTransition(from, to) {
  return to === 'cancelled' || to === 'archived' || isBackwardTransition(from, to);
}

export const SERVER_START_TIME = Date.now();
export const DASHCTL_PATH = join(import.meta.dirname, 'dashctl.sh');
export const PID_FILE = join(ROOT, 'tmp', 'dashboard.pid');
export const LOG_FILE = join(ROOT, 'tmp', 'dashboard.log');

export const PIPELINE_STAGES = Object.freeze([
  'worktree_setup', 'investigating', 'planning', 'plan_review',
  'implementing', 'testing', 'code_review', 'committing',
  'merge_pending', 'done',
]);

export const DISPATCH_TIMEOUT_MS = {
  trivial: 5 * 60 * 1000,
  small:   15 * 60 * 1000,
  medium:  60 * 60 * 1000,
  large:   2 * 60 * 60 * 1000,
};

export const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? '', 10) || 20 * 1000;
export const TIMEOUT_WARNING_RATIO = 0.8;
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
export const MAX_AUTO_EXTENDS = 1;
export const EXTEND_DURATION_MS = 30 * 60 * 1000;

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
export const BACKUP_DIR = join(ROOT, 'assets', 'backups');

export const INPUT_NEEDED_SOURCE = Object.freeze({
  BRIDGE: 'agent_phase_bridge',
  USER: 'user',
  BLOCKING_QUESTIONS: 'blocking_questions',
  TIMEOUT: 'timeout',
});

export const TMUX_AVAILABLE = (() => {
  try {
    execFileSync('which', ['tmux'], { encoding: 'utf8' });
    return true;
  } catch { return false; }
})();
