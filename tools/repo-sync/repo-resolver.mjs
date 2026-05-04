import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REGISTRY_PATH = `${process.env.HOME}/.architect/portfolio/registry.json`;

function extractRepoName(remoteUrl) {
  const sshMatch = remoteUrl.match(/git@github\.com:[^/]+\/(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = remoteUrl.match(/https:\/\/github\.com\/[^/]+\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];
  return null;
}

export async function buildRepoMap() {
  let registry;
  try {
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    registry = JSON.parse(raw);
  } catch {
    console.warn(`[repo-resolver] registry.json not found at ${REGISTRY_PATH}, returning empty map`);
    return new Map();
  }

  const map = new Map();

  for (const [portfolioKey, entry] of Object.entries(registry)) {
    if (!portfolioKey.startsWith('neuronic/')) continue;

    const localPath = entry?.path;
    if (!localPath) continue;

    let remoteUrl;
    try {
      remoteUrl = execSync(`git -C "${localPath}" remote get-url origin`, {
        encoding: 'utf8',
        timeout: 10000,
      }).trim();
    } catch (err) {
      console.warn(`[repo-resolver] skipping ${portfolioKey}: git remote get-url failed — ${err.message}`);
      continue;
    }

    const repoName = extractRepoName(remoteUrl);
    if (!repoName) {
      console.warn(`[repo-resolver] skipping ${portfolioKey}: could not parse repo name from "${remoteUrl}"`);
      continue;
    }

    map.set(repoName, { localPath, portfolioKey });
  }

  return map;
}
