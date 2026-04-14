# Work Tracking

## Overview

The `/work` command provides persistent work item and epic tracking across sessions. Items are stored in `work/backlog.json` grouped by project key. Epics provide cross-project strategic grouping.

## Work Item Commands

| Command | Action |
|---------|--------|
| `/work` | Show open and in-progress items |
| `/work add <title> [options]` | Create a work item |
| `/work show <ID>` | Full detail with session log |
| `/work update <ID> <status>` | Change status |
| `/work log <ID> <message>` | Append session log entry |
| `/work list [filters]` | Filtered listing |
| `/work remove <ID>` | Delete an item |
| `/work depend <ID> <ID> [...]` | Add dependencies |
| `/work undepend <ID> <ID> [...]` | Remove dependencies |

## Options for `add`

- `--project <org/project/component>` — link to portfolio project (auto-resolved from cwd if omitted)
- `--priority <low|medium|high|critical>` — default: medium
- `--tags <a,b,c>` — comma-separated tags
- `--epic <E-XXX>` — link to an existing epic

## Filters for `list`

- `--status <open|ready|in-progress|blocked|done|cancelled>`
- `--project <org/project/component>` — supports comma-separated values for multi-project filtering
- `--org <org-name>` — scope to all projects in an organization
- `--tag <tag>`

## Organization & Multi-Project Scoping

Filter work items by organization or across multiple projects:

```
/work list --org neuronic                                         All items in neuronic org
/work list --project neuronic/light-app/main,neuronic/cloud/main  Items from two projects
/work list --org neuronic --project neuronic/light-app/main       Combined: org narrows, project filters within
```

`--org` and `--project` can be combined: org narrows first, then project filters within the org scope.

## Dependencies

Work items support multi-dependency tracking via the `depends_on` array field.

### Dependency Commands

| Command | Action |
|---------|--------|
| `/work depend <W-XXX> <W-YYY> [...]` | W-XXX depends on W-YYY (and others) |
| `/work undepend <W-XXX> <W-YYY> [...]` | Remove dependencies from W-XXX |

### Cross-Project Dependencies

Dependencies work across project boundaries since work item IDs are globally unique. An item in `acme/frontend/main` can depend on an item in `acme/backend/main`.

### Cycle Detection

Before adding a dependency, the system performs a DFS from the target back through `depends_on` edges. If the source item is reachable, the dependency is rejected to prevent circular chains.

### Display Ordering

Both CLI and dashboard use topological sort (Kahn's algorithm) for work item listings. Items with no dependencies appear first, followed by items whose dependencies are all listed above them. Within the same level, items are sorted by priority (critical > high > medium > low) then by ID.

## Work Item Statuses

| Status | Meaning |
|--------|---------|
| open | Created, not yet planned |
| ready | Plan reviewed and approved by technical review board, cleared for implementation |
| in-progress | Implementation underway |
| blocked | Waiting on dependency or external input |
| done | Code reviewed and approved, merged |
| cancelled | No longer needed |

### Two-Gate Lifecycle

The Review Board operates as two quality gates in the work item lifecycle:

```
open → [Plan Gate] → ready → in-progress → [Code Gate] → done
```

- **Plan Gate**: After the planner produces a plan (medium+ complexity), the technical review board evaluates it. On approval, the work item transitions to `ready`.
- **Code Gate**: After implementation and tests pass, the board evaluates the code diff. On approval, the work item proceeds to commit and `done`.

See `domain/rules.md` → Review Board Rules for full details.

## Epics

Epics are cross-project strategic goals that group related work items. They span multiple projects and provide a higher-level view of progress.

### Epic Commands

| Command | Action |
|---------|--------|
| `/work epic list [--status X]` | List epics (default: draft + active) |
| `/work epic create <title> [options]` | Create an epic |
| `/work epic show <E-XXX>` | Full detail with linked items |
| `/work epic update <E-XXX> <status>` | Change epic status |
| `/work epic link <E-XXX> <W-XXX> [...]` | Link work items to epic |
| `/work epic unlink <E-XXX> <W-XXX>` | Unlink a work item |
| `/work epic log <E-XXX> <message>` | Append session log entry |
| `/work epic plan <E-XXX> [--edit]` | View or edit epic plan |
| `/work epic doc <E-XXX> [--edit]` | View or edit epic docs |

### Epic Statuses

| Status | Meaning |
|--------|---------|
| draft | Planning phase, no work started |
| active | Work is underway |
| done | All linked items completed |
| cancelled | Abandoned |

### Cross-Project Usage

Epics are top-level entities (not nested under a project). When work items from different projects are linked, the epic's `project_keys` field is auto-derived. This enables tracking strategic goals that span frontend, backend, and infrastructure.

### Dashboard

The dashboard shows epics in the sidebar above the org tree. Clicking an epic opens a detail view with four tabs:
- **Tasks** — progress bar, linked items table, link/unlink controls
- **Planning** — markdown plan editor (`work/epics/E-XXX/plan.md`)
- **Documentation** — markdown doc editor (`work/epics/E-XXX/docs.md`)
- **Details** — metadata form, session log, dispatch button

Epic-aware dispatch includes epic context (title, progress, acceptance criteria, linked items, plan excerpt) in the agent prompt.

## Session Log

Each item and epic has an append-only session log for cross-session continuity. Use `/work log W-001 "message"` or `/work epic log E-001 "message"` to record progress.

## Data Store

- `work/backlog.json` — work items (W-XXX) and epics (E-XXX) in a single file
- `work/epics/E-XXX/plan.md` — epic plan documents
- `work/epics/E-XXX/docs.md` — epic documentation

IDs are sequential and never reused.

## PM Integration

PM suggests work items for medium+ complexity requests. The orchestrator presents the suggestion and creates it only after user confirmation.
