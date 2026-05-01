import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHITECT_ROOT = join(__dirname, '..', '..');

const EXEC_OPTS = { encoding: 'utf8', timeout: 60000 };

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(localPath, branch) {
  const delays = [2000, 4000, 8000];
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      execSync(`git -C "${localPath}" fetch origin "${branch}" --quiet`, EXEC_OPTS);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < delays.length) {
        await sleep(delays[attempt]);
      }
    }
  }
  throw lastErr;
}

export async function cloneRepo(repoName, branch) {
  const mirrorPath = join(ARCHITECT_ROOT, 'work', 'mirrors', repoName);
  mkdirSync(join(ARCHITECT_ROOT, 'work', 'mirrors'), { recursive: true });

  execSync(
    `git clone "git@github.com:NeuronicPBM/${repoName}.git" "${mirrorPath}" --branch "${branch}" --single-branch`,
    { ...EXEC_OPTS, timeout: 120000 }
  );

  const shaAfter = execSync(`git -C "${mirrorPath}" rev-parse HEAD`, EXEC_OPTS).trim();
  return { sha_before: null, sha_after: shaAfter, new_commits: true, cloned: true, localPath: mirrorPath };
}

export async function fetchAndPull(localPath, branch) {
  if (!localPath || !existsSync(localPath)) {
    const repoName = localPath ? localPath.split('/').pop() : branch;
    return cloneRepo(repoName, branch);
  }

  execSync(`git -C "${localPath}" rev-parse --is-inside-work-tree`, EXEC_OPTS);

  const sha_before = execSync(`git -C "${localPath}" rev-parse HEAD`, EXEC_OPTS).trim();

  await fetchWithRetry(localPath, branch);

  execSync(`git -C "${localPath}" merge --ff-only "origin/${branch}"`, EXEC_OPTS);

  const sha_after = execSync(`git -C "${localPath}" rev-parse HEAD`, EXEC_OPTS).trim();

  return { sha_before, sha_after, new_commits: sha_before !== sha_after };
}
