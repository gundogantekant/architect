# Use Case: Sync Portfolio Knowledge

Scan a managed project's git history since the last sync anchor and record new commits as `ChangeLogEntry` rows. Surfaces architectural and dependency changes to agents and session-start blocks. Runs as a background operation — never blocks the calling session.

## Input

- `project_key` — `org/project/component` string identifying the target in the portfolio registry
- `trigger` — `session_start | scheduled | manual`
- `since_sha` (optional) — override the DB anchor; forces scan from this SHA instead of the stored `commit_to`

## Output

- `SyncRecord` row updated to `completed` with final counts and `summary_json`
- `ChangeLogEntry` rows inserted for `architectural`, `dependency`, `feature`, and `fix` commits
- Session-start summary surfaced to the orchestrator when `significant_count > 0` and trigger is `session_start`

## Preconditions

- `portfolio/registry.json` exists and is readable
- The target project has a `path` field in its portfolio entry
- `git` is available on `PATH` and the project path is a valid git repository

## Steps

1. **Resolve project path** — read `portfolio/registry.json` and look up `project_key` to get the component JSON path. Load the component entry and extract `path`. If `since_sha` is provided, use it as the anchor and skip Step 2's DB query.

2. **Read last sync anchor** — call `GET /api/sync/:project_key/history`. If results exist, use the first result's `commit_to` as the anchor SHA. If no history exists (first run), run:
   ```
   git -C <path> rev-list --max-parents=0 HEAD
   ```
   to get the initial commit SHA and use that as the anchor.

3. **Insert pending sync record** — `POST /api/sync/trigger` with `{ project_key, trigger }`. Store the returned `sync_id`. If a concurrent sync is already `running` for this `project_key`, log `status=skipped` and exit silently.

4. **Run git log** — execute:
   ```
   git -C <path> log <anchor>..HEAD --format="COMMIT %H %ai %s" --no-merges --name-only 2>/dev/null
   ```
   If the command exits non-zero or the path is not a valid repository, call `PATCH /api/sync/:sync_id` with `{ status: "failed", error: "<reason>" }` and exit. Preserve the previous `commit_to` anchor for retry.

5. **Parse output** — call `parseSyncLogOutput(rawOutput)` from `tools/dashboard/sync-classifier.mjs`. If the result is an empty array (no new commits), call `PATCH /api/sync/:sync_id` with `{ status: "completed", commits_scanned: 0, significant_count: 0 }` and exit.

6. **Classify commits** — for each parsed commit, call `classifyCommit(subject, files)` and `isAdrCandidate(subject, files)` from `sync-classifier.mjs`. Build a `ChangeLogEntry` list keeping only commits classified as `architectural`, `dependency`, `feature`, or `fix`. Discard `docs`, `test`, and `chore` — they do not affect portfolio knowledge.

7. **Insert entries** — `POST /api/sync/entries` with the `ChangeLogEntry` array. The endpoint uses `INSERT OR IGNORE` semantics; the unique constraint on `(project_key, commit_hash)` prevents duplicate rows across re-runs.

8. **Prune old entries** — entries older than 90 days are deleted. If more than 100 entries remain per project after date pruning, remove the oldest beyond 100.

9. **Build summary** — from the classified list, select commits with classification `architectural` or `dependency`. Map each to a `SyncCommitEntry` object (see `domain/entities.md` → SyncCommitEntry). Set `adr_candidate` and `adr_candidate_reason` from the `isAdrCandidate` result.

10. **Complete sync record** — `PATCH /api/sync/:sync_id` with:
    ```json
    {
      "status": "completed",
      "commit_to": "<HEAD SHA at scan time>",
      "commits_scanned": <total parsed>,
      "significant_count": <architectural + dependency count>,
      "summary_json": <JSON.stringify(summaryArray)>
    }
    ```

11. **Surface session-start summary** (only when `trigger === "session_start"` AND `significant_count > 0`) — emit a single-line message to the orchestrator's session-start block:

    > Knowledge synced — N repo(s), X architectural/dependency changes detected: [project_key — brief description]

    Do not block or await further action. The orchestrator surfaces this to the user as a passive note, not a request.

## Error Handling

- Any unhandled exception in Steps 4–10: call `PATCH /api/sync/:sync_id` with `{ status: "failed", error: "<message>" }`.
- Never throw or propagate errors to the calling session — log and exit.
- On `status=failed`, the previous `commit_to` anchor is preserved for the next sync attempt.

---

## /sync adr Workflow

Converts a commit flagged as `adr_candidate` into a portfolio `ArchitecturalDecisionRecord`.

### Trigger

User runs `/sync adr <project_key> <sha>`, or the orchestrator surfaces the suggestion during a session-start knowledge sync summary when `adr_candidate: true` entries are present.

### Steps

1. **Fetch commit detail** — run `git -C <path> show <sha> --stat --unified=5` to get the diff and changed files. Load the corresponding `ChangeLogEntry` row to retrieve the existing classification and `adr_candidate_reason`.

2. **Draft ADR** — dispatch `tech-reviewer-arch` (model: sonnet) with the commit message, diff, and `adr_candidate_reason`. Prompt it to produce a draft `ArchitecturalDecisionRecord` JSON following the schema in `domain/entities.md` → ArchitecturalDecisionRecord. Set:
   - `status: "proposed"`
   - `author: "agent:tech-reviewer-arch"`
   - `source_work_item` — the current work item if one is active, otherwise omit
   - `project_key` — from input

3. **Present for review** — show the draft ADR JSON to the user. Wait for approval, rejection, or inline edits. Do not write any files until the user confirms.

4. **On approval** — determine the next ADR ID by listing `portfolio/<org>/<project>/adrs/` and incrementing the highest existing `NNN`. Write `portfolio/<org>/<project>/adrs/ADR-NNN.json` with `status: "accepted"`. Create the `adrs/` directory if it does not exist.

5. **Update component entry** — read `portfolio/<org>/<project>/<component>.json`, append the new ADR ID to the `adrs` array (create the field if absent), and write the file back.

6. **Clear adr_candidate flag** — update the `ChangeLogEntry` row for `<sha>`: set `ai_summary` to the ADR ID (e.g. `ADR-003`) for traceability. The presence of a non-null `ai_summary` serves as the flag-cleared indicator.
