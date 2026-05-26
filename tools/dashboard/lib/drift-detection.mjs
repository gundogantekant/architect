import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Detect file-level drift between two branches by comparing their changes
 * since the common ancestor (merge-base).
 *
 * Returns files modified in both branches — candidates for merge conflict.
 * Uses async execFile (never execFileSync).
 */
export async function detectBranchDrift(repoPath, targetBranch, worktreeBranch) {
  const opt = { cwd: repoPath };
  const { stdout: baseOut } = await exec('git', ['merge-base', targetBranch, worktreeBranch], opt);
  const ancestor = baseOut.trim();
  const [{ stdout: targetFiles }, { stdout: worktreeFiles }] = await Promise.all([
    exec('git', ['diff', '--name-only', ancestor, targetBranch], opt),
    exec('git', ['diff', '--name-only', ancestor, worktreeBranch], opt),
  ]);
  const targetSet = new Set(targetFiles.trim().split('\n').filter(Boolean));
  const conflicting = worktreeFiles.trim().split('\n').filter(f => f && targetSet.has(f));
  return { conflicting };
}
