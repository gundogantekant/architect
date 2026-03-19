---
name: work
description: Track work items across sessions
user_invocable: true
arguments:
  - name: subcommand
    description: "Action: add, show, update, log, list, remove (default: list open+in-progress)"
    required: false
  - name: args
    description: "Arguments for the subcommand (title, ID, status, message, filters)"
    required: false
---

# /work

Persistent work item tracking across sessions. Items are grouped by project key in `work/backlog.json`.

## Agents Dispatched
- **tracker** (haiku) — work item management

## Steps

1. Determine project scope:
   - If cwd is inside a known project (resolve via `portfolio/registry.json`), scope display to that project by default
   - If no project context detected, show all projects
   - Explicit `--project` flag overrides auto-detection
2. Follow `usecases/track-work.md` with:
   - subcommand from `$ARGUMENTS.subcommand` (default: list)
   - args from `$ARGUMENTS.args`
   - resolved project scope from step 1

See `domain/entities.md` → WorkItem, WorkBacklog for data schemas.
See `domain/rules.md` → Work Item Rules for ID format and status rules.

## Usage

```
/work                                          Show open + in-progress items grouped by project
/work add "Migrate state management"           Create under auto-detected project
/work add "Add rate limiting" --project neuronic/cloud/main --priority high --tags api,feature
/work show W-001                               Full detail + session log (searches across projects)
/work update W-001 in-progress                 Change status
/work log W-001 "Completed investigation phase"  Append log entry
/work list --status blocked                    Filter by status across all projects
/work list --project neuronic/light-app/main   Scope to one project
/work list --tag refactor                      Filter by tag across all projects
/work list --org neuronic                              Scope to all projects in an org
/work list --project neuronic/light-app/main,neuronic/cloud/main   Multiple projects
/work list --org neuronic --project neuronic/light-app/main        Combined filters
/work remove W-001                             Delete (with confirmation)
/work plan W-001                               Show plan for work item
/work plan W-001 --edit                        Edit plan for work item
/work docs W-001                               Show docs for work item
/work docs W-001 --edit                        Edit docs for work item
/work depend W-003 W-001                       W-003 depends on W-001
/work depend W-005 W-001 W-003                 W-005 depends on W-001 and W-003
/work undepend W-005 W-003                     Remove W-003 dependency from W-005
```
