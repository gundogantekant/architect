# Use Case: Scheduled Repository Sync

Pull new commits from enabled GitHub mirrors, trigger portfolio knowledge syncs, and produce an org-wide activity summary. Runs unattended — never blocks any user session.

## Trigger

- macOS launchd at 08:00 and 20:00 (system schedule)
- Manual via `POST /api/repo-sync/run-now`

## Preconditions

- At least one `RepoSyncConfig` row has `sync_enabled=TRUE` and a non-null `local_path`
- Dashboard server is running (health-checked before work begins)

## Main Flow

1. **Acquire lock** — write PID to `tmp/repo-sync.lock`. If the file exists and its PID is alive, exit immediately (another run is active). If PID is dead, overwrite (dead-PID-aware).

2. **Dashboard health check** — `GET /api/server/status`. If the request fails or returns non-200, log the error and exit (lock released).

3. **Fetch enabled repos** — `GET /api/repos/enabled`. Returns `RepoSyncConfig[]` where `sync_enabled=TRUE` and `local_path` is non-null.

4. **Pull each repo (sequential)** — for each repo:
   - `git -C <local_path> fetch origin <default_branch>`
   - `git -C <local_path> merge --ff-only origin/<default_branch>`
   - If merge exits non-zero (diverged), log a warning, skip this repo, continue to next.
   - Record whether HEAD changed (new commits present).

5. **Trigger portfolio sync** — for each repo with new commits and a non-null `portfolio_key`:
   - `POST /api/sync/trigger` with `{ project_key: portfolio_key, trigger: "scheduled", sync_source: "remote" }`

6. **Poll for sync completion** — for each triggered sync, poll `GET /api/sync/:key/history` up to 10 times with 10 s backoff. If the sync does not reach `completed` within the polling window, log a warning and continue.

7. **Check for new-commit repos** — if no repo produced new commits, release lock and exit silently.

8. **Extract structured data (Haiku)** — for each repo with new commits, call Haiku with the `change_log_entries` rows (up to 10 per repo). Produce structured JSON: `{ repo, commits: [{ sha, author, message, classification, ai_summary }] }`.

9. **Synthesise org summary (Sonnet)** — call Sonnet with all per-repo JSON from Step 8. Produce an `OrgActivitySummary` with four sections: Technical Changelog, Developer Activity table, Repository Summaries, ADR Candidates list.

10. **Write ADR detail files** — for each `AdrCandidate` in the summary:
    - Write `~/.architect/portfolio/neuronic/adrs/<id>.md` with the candidate detail.
    - `POST /api/adrs` with the candidate metadata.

11. **Append to sync log** — append the full `OrgActivitySummary` as a dated Markdown block to `~/.architect/portfolio/neuronic/sync-log.md`.

12. **Release lock** — delete `tmp/repo-sync.lock`.

## Exception Flows

- **Dashboard not running** (Step 2): log error, release lock, exit.
- **Repo diverged** (Step 4): skip repo, log warning, continue with remaining repos.
- **Haiku/Sonnet failure** (Steps 8–9): log error, skip summary pipeline, don't fail the run.
- **Lock held by live PID** (Step 1): exit immediately — another run is active.

## Related

- `/sync` skill — local-only portfolio sync; sets `sync_source: 'local'`; does not pull git remotes
- `tools/dashboard/repo-resolver.mjs` — builds a `Map<portfolio_key, RepoSyncConfig>` from `portfolio/registry.json`

## Outputs

- Updated `knowledge_syncs` rows (one per synced repo) with `sync_source: 'remote'`
- `change_log_entries` rows inserted for new commits
- `adrs` DB rows and `~/.architect/portfolio/neuronic/adrs/<id>.md` files for ADR candidates
- Appended entry in `~/.architect/portfolio/neuronic/sync-log.md`
