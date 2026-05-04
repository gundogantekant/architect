import { spawnSync } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORTFOLIO_ROOT = `${process.env.HOME}/.architect/portfolio`;
const SPAWN_OPTS = { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 };

function runClaude(model, prompt) {
  const result = spawnSync('claude', ['-p', '--model', model], {
    input: prompt,
    ...SPAWN_OPTS,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`claude exited with status ${result.status}: ${result.stderr}`);
  }
  return result.stdout;
}

function since2DaysAgo() {
  const d = new Date();
  d.setDate(d.getDate() - 2);
  return d.toISOString();
}

function formatEntries(repoName, entries) {
  return `[REPO: ${repoName}]\n` +
    entries.map(e => `${e.commit_hash} ${e.author} ${e.commit_message} (${e.classification})`).join('\n');
}

function buildHaikuPrompt(entryBlocks) {
  return `You are a structured data extractor. Return ONLY valid JSON, no markdown.

Extract from the following commit log entries:
${entryBlocks.join('\n\n')}

Return JSON:
{
  "repos": [
    {
      "repo": "<github_repo_name>",
      "commits": [{ "hash": "...", "author": "...", "message": "...", "classification": "..." }],
      "authors": ["..."],
      "commit_count": 0
    }
  ]
}`;
}

function buildSonnetPrompt(haikuJson) {
  return `You are an engineering knowledge base writer for the NeuronicPBM organization.
Given the following structured commit data from the last sync run, produce a 4-section report.

${JSON.stringify(haikuJson, null, 2)}

Produce exactly this structure with these exact section headers:

## Technical Changelog
<org-wide narrative of what changed, key themes, patterns>

## Developer Activity
| Developer | Repos | Summary |
|-----------|-------|---------|
<one row per active developer>

## Repository Summaries
<one subsection per repo: ### <repo-name>\\nBranch: <branch> | Commits: N\\n<narrative>

## ADR Candidates
| Title | Repos | Type | Significance |
|-------|-------|------|-------------|
<only include real architectural decisions — skip if none exist>
Types: architectural | dependency | feature | api-contract`;
}

function parseAdrTable(sonnetOutput) {
  const adrSection = sonnetOutput.split('## ADR Candidates')[1];
  if (!adrSection) return [];

  const lines = adrSection.split('\n').filter(l => l.trim());
  const rows = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    if (line.includes('Title') || line.match(/^[\s|:-]+$/)) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 4) continue;
    const [title, reposRaw, type, significance] = cols;
    if (!title || title === 'Title') continue;
    const repos = reposRaw.split(/[,\s]+/).map(r => r.trim()).filter(Boolean);
    const validTypes = ['architectural', 'dependency', 'feature', 'api-contract'];
    const normalizedType = validTypes.includes(type) ? type : 'architectural';
    rows.push({ title, repos, type: normalizedType, significance });
  }
  return rows;
}

function generateAdrId(index, now) {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const num = String(index + 1).padStart(3, '0');
  return `ADR-${datePart}-${num}`;
}

async function storeAdr(adr, orgKey, syncRunId, dashboardUrl) {
  const adrsDir = join(PORTFOLIO_ROOT, orgKey, 'adrs');
  mkdirSync(adrsDir, { recursive: true });

  const detailPath = join(adrsDir, `${adr.id}.md`);
  const content = `# ${adr.id}: ${adr.title}\n\nType: ${adr.type}\nRepos: ${adr.repos.join(', ')}\nSync Run: ${syncRunId || 'N/A'}\n\nSignificance: ${adr.significance}\n`;
  writeFileSync(detailPath, content, 'utf8');

  await fetch(`${dashboardUrl}/api/adrs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: adr.id,
      org_key: orgKey,
      title: adr.title,
      type: adr.type,
      repos: adr.repos,
      sync_run_id: syncRunId || null,
      detail_path: detailPath,
    }),
  });

  return detailPath;
}

function appendSyncLog(orgKey, sonnetOutput, repoCount, changeCount) {
  const syncLogDir = join(PORTFOLIO_ROOT, orgKey);
  mkdirSync(syncLogDir, { recursive: true });
  const syncLogPath = join(syncLogDir, 'sync-log.md');
  const timestamp = new Date().toISOString();
  const entry = `## Sync Run — ${timestamp} (${repoCount} repos, ${changeCount} changes)\n\n${sonnetOutput.trim()}\n\n---\n`;
  appendFileSync(syncLogPath, entry, 'utf8');
}

export async function generateSummary(syncedRepos, dashboardUrl) {
  const sinceIso = since2DaysAgo();
  const entryBlocks = [];
  const repoEntryCounts = new Map();

  for (const repo of syncedRepos) {
    if (!repo.portfolio_key) continue;

    let entries;
    try {
      const url = `${dashboardUrl}/api/sync/entries?project_key=${encodeURIComponent(repo.portfolio_key)}&since=${encodeURIComponent(sinceIso)}`;
      const res = await fetch(url);
      if (!res.ok) {
        console.warn(`[activity-summarizer] entries fetch failed for ${repo.portfolio_key}: HTTP ${res.status}`);
        continue;
      }
      entries = await res.json();
    } catch (err) {
      console.warn(`[activity-summarizer] entries fetch error for ${repo.portfolio_key}: ${err.message}`);
      continue;
    }

    if (!entries || entries.length === 0) continue;

    entryBlocks.push(formatEntries(repo.github_repo_name, entries));
    repoEntryCounts.set(repo.github_repo_name, entries.length);
  }

  if (entryBlocks.length === 0) {
    console.log('[activity-summarizer] no entries to summarize');
    return { adrs_created: 0, repos_summarized: 0 };
  }

  const haikuPrompt = buildHaikuPrompt(entryBlocks);
  let haikuJson;
  try {
    const haikuRaw = runClaude('claude-haiku-4-5', haikuPrompt);
    haikuJson = JSON.parse(haikuRaw.trim());
  } catch (err) {
    console.error(`[activity-summarizer] Haiku extraction failed: ${err.message}`);
    return { adrs_created: 0, repos_summarized: 0 };
  }

  const sonnetPrompt = buildSonnetPrompt(haikuJson);
  let sonnetOutput;
  try {
    sonnetOutput = runClaude('claude-sonnet-4-6', sonnetPrompt);
  } catch (err) {
    console.error(`[activity-summarizer] Sonnet synthesis failed: ${err.message}`);
    return { adrs_created: 0, repos_summarized: 0 };
  }

  const adrCandidates = parseAdrTable(sonnetOutput);
  const now = new Date();
  let adrsCreated = 0;

  const firstSyncRunId = syncedRepos.find(r => r.sync_id)?.sync_id || null;

  for (let i = 0; i < adrCandidates.length; i++) {
    const adr = { ...adrCandidates[i], id: generateAdrId(i, now) };
    try {
      await storeAdr(adr, 'neuronic', firstSyncRunId, dashboardUrl);
      adrsCreated++;
    } catch (err) {
      console.warn(`[activity-summarizer] failed to store ADR ${adr.id}: ${err.message}`);
    }
  }

  const totalChanges = [...repoEntryCounts.values()].reduce((a, b) => a + b, 0);
  appendSyncLog('neuronic', sonnetOutput, entryBlocks.length, totalChanges);

  return { adrs_created: adrsCreated, repos_summarized: entryBlocks.length };
}
