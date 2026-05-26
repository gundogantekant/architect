/**
 * Drift Detection Tests (W-1205 Phase C)
 *
 * Unit tests for detectBranchDrift() — a pure async utility that identifies
 * files modified in both a target branch and a worktree branch since their
 * common ancestor, using git diff --name-only against merge-base.
 *
 * These tests create real temp git repos so no mocking is needed.
 */

import { test, expect } from './fixtures.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { detectBranchDrift } from '../lib/drift-detection.mjs';

const exec = promisify(execFile);

async function git(args, cwd) {
  return exec('git', args, { cwd });
}

async function createTempRepo() {
  const repoPath = join(tmpdir(), `drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(repoPath, { recursive: true });

  await git(['init', '--initial-branch=main'], repoPath).catch(() => git(['init'], repoPath));
  await git(['config', 'user.email', 'test@test.com'], repoPath);
  await git(['config', 'user.name', 'Test'], repoPath);

  // Initial commit with shared files
  writeFileSync(join(repoPath, 'shared.txt'), 'initial content');
  writeFileSync(join(repoPath, 'other.txt'), 'other content');
  await git(['add', '.'], repoPath);
  await git(['commit', '-m', 'initial'], repoPath);

  return repoPath;
}

test.describe('Branch Drift Detection @fast', () => {

  test('DD-1: branches touching disjoint files produce no conflicting files', async () => {
    const repoPath = await createTempRepo();

    // Create target branch with its own file
    await git(['checkout', '-b', 'target'], repoPath);
    writeFileSync(join(repoPath, 'target-only.txt'), 'target change');
    await git(['add', '.'], repoPath);
    await git(['commit', '-m', 'target change'], repoPath);

    // Create worktree branch from main with its own file
    await git(['checkout', 'main'], repoPath);
    await git(['checkout', '-b', 'worktree-branch'], repoPath);
    writeFileSync(join(repoPath, 'worktree-only.txt'), 'worktree change');
    await git(['add', '.'], repoPath);
    await git(['commit', '-m', 'worktree change'], repoPath);

    const result = await detectBranchDrift(repoPath, 'target', 'worktree-branch');
    expect(result.conflicting).toEqual([]);
  });

  test('DD-2: both branches modifying the same file yields that file in conflicting', async () => {
    const repoPath = await createTempRepo();

    // Create target branch — modifies shared.txt
    await git(['checkout', '-b', 'target'], repoPath);
    writeFileSync(join(repoPath, 'shared.txt'), 'target version');
    await git(['add', '.'], repoPath);
    await git(['commit', '-m', 'target modifies shared'], repoPath);

    // Create worktree branch from main — also modifies shared.txt
    await git(['checkout', 'main'], repoPath);
    await git(['checkout', '-b', 'worktree-branch'], repoPath);
    writeFileSync(join(repoPath, 'shared.txt'), 'worktree version');
    await git(['add', '.'], repoPath);
    await git(['commit', '-m', 'worktree modifies shared'], repoPath);

    const result = await detectBranchDrift(repoPath, 'target', 'worktree-branch');
    expect(result.conflicting).toContain('shared.txt');
    expect(result.conflicting.length).toBe(1);
  });

  test('DD-3: common ancestor is identified correctly via git merge-base', async () => {
    const repoPath = await createTempRepo();

    // Record the initial (common) commit hash
    const { stdout: initialSha } = await git(['rev-parse', 'HEAD'], repoPath);
    const ancestor = initialSha.trim();

    // Diverge both branches
    await git(['checkout', '-b', 'target'], repoPath);
    writeFileSync(join(repoPath, 'target-file.txt'), 'target');
    await git(['add', '.'], repoPath);
    await git(['commit', '-m', 'target diverges'], repoPath);

    await git(['checkout', 'main'], repoPath);
    await git(['checkout', '-b', 'worktree-branch'], repoPath);
    writeFileSync(join(repoPath, 'worktree-file.txt'), 'worktree');
    await git(['add', '.'], repoPath);
    await git(['commit', '-m', 'worktree diverges'], repoPath);

    // Verify git merge-base returns the initial commit
    const { stdout: mergeBase } = await git(['merge-base', 'target', 'worktree-branch'], repoPath);
    expect(mergeBase.trim()).toBe(ancestor);

    // detectBranchDrift should produce no conflicts (disjoint files)
    const result = await detectBranchDrift(repoPath, 'target', 'worktree-branch');
    expect(result.conflicting).toEqual([]);
  });

});
