# Portfolio Key Hygiene

## Valid Org Names

Org names must match `/^[a-zA-Z][a-zA-Z0-9_-]*$/`:
- Must start with a letter (a–z or A–Z)
- Subsequent characters: letters, digits, underscores, hyphens
- Case-insensitive for blocked-name checks

## Blocked Names

The following org names are rejected as reserved or suspicious:

`test`, `testorg`, `fake`, `tmp`, `demo`, `dev`, `local`, `debug`

These often indicate leftover test data rather than real projects.

## How the Guard Works

On startup, `syncProjectsFromRegistry()` in `dispatch-manager.mjs` iterates every registry entry and calls `validateOrgName(entry.org)`. If validation fails:

1. The entry is skipped (not upserted into the `projects` table).
2. An error is logged: `[syncProjectsFromRegistry] skipping registry entry — <reason>: <key>`.
3. The skipped entry is collected in `skippedEntries` and exposed via `GET /api/server/status` as `sync_warnings`.

The validation logic lives in `tools/dashboard/lib/portfolio-validation.mjs`.

## Finding and Fixing Orphan Entries

Use the `#audit` page in the dashboard (`/#audit`) to identify:
- **DB Keys Without Portfolio Profile** — work items whose `project_key` has no matching portfolio JSON file.
- **Portfolio Profiles Without Backlog Items** — portfolio component files with no work items in the DB.

To fix an orphan DB key, either:
- Onboard the missing project with `/onboard <path>`, or
- Reassign or cancel the affected work items to a valid project key.

To fix an orphan portfolio entry, run `/onboard <path> rescan` or remove the stale JSON file.
