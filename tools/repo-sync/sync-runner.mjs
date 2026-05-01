#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { fetchAndPull } from './git-ops.mjs';
import { generateSummary } from './activity-summarizer.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHITECT_ROOT = join(__dirname, '..', '..');

const LOCK_FILE = join(ARCHITECT_ROOT, 'tmp', 'repo-sync.lock');
const POLL_INTERVAL_MS = 10000;
const POLL_MAX_ATTEMPTS = 10;

function parseArgs() {
  const args = process.argv.slice(2);
  let dashboardUrl = 'http://127.0.0.1:3777';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dashboard-url' && args[i + 1]) {
      dashboardUrl = args[i + 1];
    }
  }
  return { dashboardUrl };
}

function acquireLock() {
  mkdirSync(join(ARCHITECT_ROOT, 'tmp'), { recursive: true });
  if (existsSync(LOCK_FILE)) {
    const existing = readFileSync(LOCK_FILE, 'utf8').trim();
    const pid = parseInt(existing, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        console.error(`[sync-runner] already running (PID ${pid}), exiting`);
        process.exit(1);
      } catch {
        console.log(`[sync-runner] stale lock (PID ${pid}), overwriting`);
      }
    }
  }
  writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
}

function releaseLock() {
  try {
    rmSync(LOCK_FILE);
  } catch {}
}

function registerExitHandlers() {
  const cleanup = () => {
    releaseLock();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

async function healthCheck(dashboardUrl) {
  try {
    const res = await fetch(`${dashboardUrl}/api/server/status`, { signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function getEnabledRepos(dashboardUrl) {
  const res = await fetch(`${dashboardUrl}/api/repos/enabled`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function triggerSync(dashboardUrl, portfolioKey) {
  const res = await fetch(`${dashboardUrl}/api/sync/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_key: portfolioKey, trigger: 'scheduled', sync_source: 'remote' }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    console.warn(`[sync-runner] trigger failed for ${portfolioKey}: HTTP ${res.status}`);
    return null;
  }
  const data = await res.json();
  return data?.id || data?.sync_id || null;
}

async function pollSyncCompletion(dashboardUrl, portfolioKey) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${dashboardUrl}/api/sync/${encodeURIComponent(portfolioKey)}/history`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const history = await res.json();
      if (!history || history.length === 0) continue;
      const latest = history[0];
      if (latest.status === 'completed') return 'completed';
      if (latest.status === 'failed') return 'failed';
    } catch (err) {
      console.warn(`[sync-runner] poll error for ${portfolioKey}: ${err.message}`);
    }
  }
  return 'timeout';
}

async function main() {
  const { dashboardUrl } = parseArgs();

  acquireLock();
  registerExitHandlers();

  const healthy = await healthCheck(dashboardUrl);
  if (!healthy) {
    console.error(`[sync-runner] dashboard not reachable at ${dashboardUrl}`);
    releaseLock();
    process.exit(1);
  }

  let repos;
  try {
    repos = await getEnabledRepos(dashboardUrl);
  } catch (err) {
    console.error(`[sync-runner] failed to fetch enabled repos: ${err.message}`);
    releaseLock();
    process.exit(1);
  }

  if (!repos || repos.length === 0) {
    console.log('[sync-runner] no repos enabled, exiting');
    releaseLock();
    return;
  }

  const syncedRepos = [];

  for (const repo of repos) {
    const { github_repo_name, default_branch, local_path, portfolio_key } = repo;
    console.log(`[sync-runner] processing ${github_repo_name} (branch: ${default_branch})`);

    let pullResult;
    try {
      pullResult = await fetchAndPull(local_path, default_branch);
    } catch (err) {
      console.warn(`[sync-runner] git ops failed for ${github_repo_name}: ${err.message}`);
      continue;
    }

    if (pullResult.cloned) {
      console.log(`[sync-runner] cloned ${github_repo_name} to ${pullResult.localPath}`);
    }

    let sync_id = null;
    if (pullResult.new_commits && portfolio_key) {
      try {
        sync_id = await triggerSync(dashboardUrl, portfolio_key);
        console.log(`[sync-runner] triggered sync for ${portfolio_key}, sync_id=${sync_id}`);
      } catch (err) {
        console.warn(`[sync-runner] trigger error for ${portfolio_key}: ${err.message}`);
      }
    }

    if (pullResult.new_commits) {
      syncedRepos.push({
        github_repo_name,
        portfolio_key: portfolio_key || null,
        sync_id,
        sha_before: pullResult.sha_before,
        sha_after: pullResult.sha_after,
      });
    }
  }

  const reposWithSyncId = syncedRepos.filter(r => r.sync_id && r.portfolio_key);
  for (const repo of reposWithSyncId) {
    console.log(`[sync-runner] polling completion for ${repo.portfolio_key}`);
    const status = await pollSyncCompletion(dashboardUrl, repo.portfolio_key);
    console.log(`[sync-runner] ${repo.portfolio_key} sync status: ${status}`);
  }

  if (syncedRepos.length > 0) {
    console.log(`[sync-runner] ${syncedRepos.length} repo(s) had new commits, generating summary`);
    try {
      const result = await generateSummary(syncedRepos, dashboardUrl);
      console.log(`[sync-runner] summary complete — ADRs created: ${result.adrs_created}, repos summarized: ${result.repos_summarized}`);
    } catch (err) {
      console.error(`[sync-runner] summary generation failed: ${err.message}`);
    }
  } else {
    console.log('[sync-runner] no changes since last run, skipping summary');
  }

  releaseLock();
}

main().catch((err) => {
  console.error(`[sync-runner] fatal: ${err.message}`);
  releaseLock();
  process.exit(1);
});
