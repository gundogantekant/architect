/**
 * Server-side merge execution for the autonomous pipeline.
 *
 * Handles merge-back from a worktree branch into the originating branch
 * after an auto-implement dispatch signals completion.
 *
 * See domain/rules.md → Autonomous Pipeline Rules.
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const execFile = promisify(execFileCb);

// Per-dispatch merge lock — prevents concurrent merges for the same dispatch.
const mergeLock = new Map();

/**
 * Attempt to merge a worktree branch back into its originating branch.
 *
 * @param {Object} opts
 * @param {string} opts.dispatchId   — used as the lock key
 * @param {string} opts.worktreePath — absolute path to the worktree directory
 * @param {string} opts.sourceBranch — the originating branch to merge INTO
 * @param {string} opts.projectPath  — absolute path to the main project directory (not the worktree)
 * @returns {Promise<{ success: true, mergeSha: string } | { success: false, error: string }>}
 */
export async function attemptMerge({ dispatchId, worktreePath, sourceBranch, projectPath }) {
  // 1. Check for an in-progress merge for this dispatch.
  if (mergeLock.has(dispatchId)) {
    throw new Error('Merge already in progress for this dispatch');
  }

  // 2. Acquire lock synchronously before any await.
  mergeLock.set(dispatchId, true);

  try {
    // 4. Mid-merge crash recovery: abort any leftover merge state.
    if (existsSync(join(projectPath, '.git', 'MERGE_HEAD'))) {
      try {
        await execFile('git', ['merge', '--abort'], { cwd: projectPath });
      } catch {
        // Ignore errors from the abort — best-effort cleanup.
      }
    }

    // 5. Get the worktree branch name.
    const { stdout: refStdout } = await execFile(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: worktreePath }
    );
    const worktreeBranch = refStdout.trim();

    // 6. Checkout sourceBranch in the main project.
    await execFile('git', ['checkout', sourceBranch], { cwd: projectPath });

    // 7. Attempt fast-forward merge; fall back to merge commit on failure.
    try {
      await execFile('git', ['merge', '--ff-only', worktreeBranch], { cwd: projectPath });
    } catch {
      // Fast-forward failed — attempt a merge commit.
      try {
        await execFile(
          'git',
          ['merge', '--no-ff', '-m', `Merge ${worktreeBranch} into ${sourceBranch}`, worktreeBranch],
          { cwd: projectPath }
        );
      } catch (mergeErr) {
        // Conflict or other failure — abort and report.
        try {
          await execFile('git', ['merge', '--abort'], { cwd: projectPath });
        } catch {
          // Ignore abort errors.
        }
        return { success: false, error: mergeErr.message };
      }
    }

    // 8. Capture the resulting merge SHA.
    const { stdout: shaStdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
    const mergeSha = shaStdout.trim();

    // 9. Remove the worktree (best-effort).
    try {
      await execFile('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectPath });
    } catch {
      // Ignore — worktree may already be gone or locked.
    }

    // 10. Delete the worktree branch (best-effort).
    try {
      await execFile('git', ['branch', '-d', worktreeBranch], { cwd: projectPath });
    } catch {
      // Ignore — branch may already be deleted or unmerged check fails.
    }

    // 11. Return success.
    return { success: true, mergeSha };
  } finally {
    // 3. Always release the lock.
    mergeLock.delete(dispatchId);
  }
}

/**
 * Check whether a merge is currently in progress for a given dispatch.
 * Exposed for diagnostic and test use only.
 *
 * @param {string} dispatchId
 * @returns {boolean}
 */
export function isMergeLocked(dispatchId) {
  return mergeLock.has(dispatchId);
}
