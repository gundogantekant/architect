import { resolve, join } from 'node:path';
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
export const PORTFOLIO = join(ROOT, 'portfolio');
export const WORK = process.env.WORK_DIR || join(ROOT, 'work');
export const LOGS_DIR = join(WORK, 'logs');
export const ARCHITECT_KEY = '\u2013/architect/\u2013';

export const port = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return 3777;
})();

// Valid status values — canonical source: domain/entities.md
export const VALID_WORK_ITEM_STATUSES = new Set(['open', 'in-progress', 'blocked', 'done', 'cancelled']);
export const VALID_EPIC_STATUSES = new Set(['draft', 'active', 'done', 'cancelled', 'archived']);
export const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

export const SERVER_START_TIME = Date.now();
export const DASHCTL_PATH = join(import.meta.dirname, 'dashctl.sh');
export const PID_FILE = join(ROOT, 'tmp', 'dashboard.pid');
export const LOG_FILE = join(ROOT, 'tmp', 'dashboard.log');

export const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export const TMUX_AVAILABLE = (() => {
  try {
    execFileSync('which', ['tmux'], { encoding: 'utf8' });
    return true;
  } catch { return false; }
})();
