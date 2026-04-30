/**
 * Worktree creation utility for dispatch infrastructure.
 *
 * Creates isolated git worktrees before agent spawn so each dispatch
 * runs in its own branch/directory — preventing conflicts between
 * parallel jobs on the same project.
 *
 * Decision matrix (defined in domain/rules.md → Worktree Rules):
 *   acceptEdits + work_item_id + worktree_mode:"auto" + flag + git → create
 *   plan mode / no work item / explicit mode / "none" mode / non-git / flag off → skip
 *
 * This module reads the portfolio entry's worktree_mode and executes
 * accordingly. It does NOT own the decision logic — that lives in domain rules.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const execFile = promisify(execFileCb);
const SETUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes per post_command

export async function isGitRepository(projectPath) {
  try {
    await execFile('git', ['rev-parse', '--git-dir'], { cwd: projectPath });
    return true;
  } catch {
    return false;
  }
}

/**
 * Slugify a title for use in branch names.
 * Lowercase, replace non-alphanumeric with hyphens, truncate, trim trailing hyphens.
 */
function slugify(text, maxLen = 40) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/, '');
}

/**
 * Count existing architect-managed worktrees for a project.
 */
async function countWorktrees(projectPath) {
  try {
    const { stdout } = await execFile('git', ['worktree', 'list', '--porcelain'], { cwd: projectPath });
    return (stdout.match(/^worktree /gm) || []).length;
  } catch {
    return 0;
  }
}

/**
 * Create an isolated worktree for a dispatch.
 *
 * @param {Object} opts
 * @param {string} opts.projectPath — absolute path to the target project
 * @param {Object|null} opts.portfolioEntry — PortfolioEntry JSON (may be null)
 * @param {string} opts.workItemId — work item ID (e.g. "W-927")
 * @param {string} opts.workItemTitle — human-readable title for slug
 * @param {Object|null} opts.orgConventions — organization.json conventions
 * @returns {Promise<{worktreePath: string, branchName: string, sourceBranch: string}>}
 * @throws {Error} if worktree creation fails
 */
export async function createWorktreeForDispatch({ projectPath, portfolioEntry, workItemId, workItemTitle, orgConventions }) {
  // 1. Derive names
  const projectDirName = basename(projectPath);
  const branchPrefix = orgConventions?.conventions?.branch_prefix || '';
  const slug = slugify(workItemTitle || 'task');
  const baseBranchName = `${projectDirName}-${branchPrefix}${workItemId}-${slug}`;

  // 2. Capture originating branch
  let sourceBranch;
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: projectPath });
    sourceBranch = stdout.trim();
  } catch {
    sourceBranch = 'HEAD'; // detached HEAD fallback
  }

  // 3. Compute worktree path (sibling of project dir)
  const parentDir = dirname(projectPath);
  let branchName = baseBranchName;
  let worktreePath = join(parentDir, branchName);

  // 4. Create worktree — retry once with UUID suffix on collision
  try {
    await execFile('git', ['worktree', 'add', worktreePath, '-b', branchName], { cwd: projectPath });
  } catch (firstErr) {
    // Branch or path may already exist — retry with suffix
    const suffix = randomUUID().slice(0, 8);
    branchName = `${baseBranchName}-${suffix}`;
    worktreePath = join(parentDir, branchName);
    try {
      await execFile('git', ['worktree', 'add', worktreePath, '-b', branchName], { cwd: projectPath });
    } catch (retryErr) {
      throw new Error(`Worktree creation failed: ${retryErr.message} (original: ${firstErr.message})`);
    }
  }

  // 5. Copy paths from source to worktree
  const copyPaths = portfolioEntry?.worktree_setup?.copy_paths || [];
  for (const relPath of copyPaths) {
    const src = join(projectPath, relPath);
    const dst = join(worktreePath, relPath);
    if (existsSync(src)) {
      const dstParent = dirname(dst);
      if (!existsSync(dstParent)) mkdirSync(dstParent, { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
  }

  // 6. Run post_commands in worktree
  const postCommands = portfolioEntry?.worktree_setup?.post_commands || [];
  for (const cmd of postCommands) {
    try {
      await execFile('sh', ['-c', cmd], {
        cwd: worktreePath,
        timeout: SETUP_TIMEOUT_MS,
        env: { ...process.env },
      });
    } catch (cmdErr) {
      throw new Error(`Worktree post_command failed ("${cmd}"): ${cmdErr.message}`);
    }
  }

  // 7. Log worktree count for disk pressure awareness
  const total = await countWorktrees(projectPath);
  if (total > 10) {
    console.warn(`[worktree] Project ${projectDirName} has ${total} worktrees — consider cleanup`);
  }

  return { worktreePath, branchName, sourceBranch };
}

/**
 * Check if dispatch-level worktree creation should happen.
 * Reads domain rules from portfolio entry — does NOT own decision logic.
 *
 * @param {Object} opts
 * @param {string} opts.permissionMode — 'plan' | 'acceptEdits'
 * @param {string|null} opts.workItemId — W-XXX or null
 * @param {Object|null} opts.portfolioEntry — PortfolioEntry JSON
 * @param {boolean} opts.featureFlag — worktree_at_dispatch preference
 * @returns {boolean}
 */
export function shouldCreateWorktree({ permissionMode, workItemId, portfolioEntry, featureFlag, isGit }) {
  if (!featureFlag) return false;
  if (permissionMode !== 'acceptEdits') return false;
  if (!workItemId) return false;
  if (!isGit) return false;
  const mode = portfolioEntry?.worktree_mode ?? 'auto';
  return mode === 'auto';
}

/**
 * Check whether a portfolio entry has worktree_setup configured.
 * Returns a warning object if the field is absent, null otherwise.
 *
 * @param {Object} opts
 * @param {Object|null} opts.portfolioEntry — PortfolioEntry JSON (may be null/undefined)
 * @param {string} opts.projectKey — e.g. "org/project/component"
 * @returns {{ warning: string, require_confirm: true } | null}
 */
export function checkWorktreeReadiness({ portfolioEntry, projectKey }) {
  if (portfolioEntry?.worktree_setup == null) {
    return {
      warning: `Warning: ${projectKey} has no \`worktree_setup\` configured. This project was onboarded before worktree setup detection was available. Run \`/onboard <path> rescan\` to detect runtime config files, or proceed knowing the worktree may be missing runtime configuration.`,
      require_confirm: true,
    };
  }
  return null;
}
