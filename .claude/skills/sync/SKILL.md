---
name: sync
description: Sync portfolio knowledge base with external git changes; manage ADRs
execution: dispatch
user_invocable: true
arguments:
  - name: subcommand
    description: "status | adr <project_key> <sha> — omit for full sync"
    required: false
---

# /sync Skill

Knowledge sync and ADR management for portfolio projects.

## Usage

/sync [subcommand] [args]

## Subcommands

| Subcommand | Description |
|------------|-------------|
| (none) | Trigger manual sync for all active portfolio projects |
| status | Show per-project freshness, last sync time, and pending ADR candidates |
| adr <project_key> <sha> | Draft an ADR from a flagged commit and create it on approval |

## Behavior

Follow `usecases/sync-knowledge.md` for the full workflow.

### /sync (no subcommand)
1. Read `portfolio/registry.json` to get all registered projects
2. For each project, call `POST /api/sync/trigger` with `{ project_key, trigger: "manual" }`
3. Execute the sync workflow from `usecases/sync-knowledge.md` for each project
4. Surface a summary: "Synced N projects — X architectural changes detected"

### /sync status
1. Call `GET /api/sync/status` — returns per-project freshness records
2. For each project, also call `GET /api/sync/significant?project_key=<key>` to get pending ADR candidates
3. Display a table:
   - Project key | Last synced | Freshness | Pending ADR candidates
4. Flag stale projects (>24h) with a warning

### /sync adr <project_key> <sha>
Follow the "/sync adr workflow" in `usecases/sync-knowledge.md`:
1. Resolve the project path from the registry
2. Run `git -C <path> show <sha> --stat` to get commit diff summary
3. Dispatch `tech-reviewer-arch` (sonnet) to draft an ArchitecturalDecisionRecord JSON
4. Present the draft to the user for review (do not write without approval)
5. On approval: write the ADR JSON to `portfolio/<org>/<project>/adrs/ADR-NNN.json`
6. Update the component's `adrs` array in `portfolio/<org>/<project>/<component>.json`
7. Log: "ADR-NNN created for <project_key>"

## Output

- Sync: per-project summary with commit counts and architectural change count
- Status: table of freshness records and pending ADR candidates
- ADR: confirmed ADR written to portfolio with component entry updated
