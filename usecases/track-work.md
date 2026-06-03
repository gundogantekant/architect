# Use Case: Track Work

Manage persistent work items and epics across sessions. Items are grouped by project key in `work/backlog.json`. Epics are top-level cross-project groupings.

## Input
- Subcommand: list, add, show, update, log, remove, depend, undepend, plan, docs, files, file
- Epic subcommand: epic list, epic create, epic show, epic update, epic link, epic unlink, epic log, epic plan, epic doc
- Arguments per subcommand (see `domain/entities.md` → WorkItem, Epic for schemas)

## Output
- Work item listing (grouped by project), epic listing, details, or confirmation of changes

## Agent(s)
- **tracker** (model: haiku, data-write)

## Steps

1. Parse command and arguments
2. Resolve project scope:
   - If `--org` flag provided, filter project keys to those starting with `<org>/`
   - If `--project` flag provided with comma-separated values, include items from all listed project keys
   - `--org` and `--project` can be combined (org narrows first, then project filters within)
   - If `--project` provided (single value), use as project key
   - If a session project context is active (see `domain/rules.md` → Session Project Context), use it as the default project key when no explicit `--project` or `--org` flag is provided
   - If no explicit flag and no session project context: check cwd against `portfolio/registry.json`; if matched, use that project key
   - If no project scope can be determined (no flag, no session context, no cwd match) and the command is not an explicit cross-project request: ask the user "Which project are you focused on?" before querying
   - Cross-project override: if the user's phrasing expresses global intent ("all tickets", "across all projects", "global backlog"), skip all scope filtering
   - Epic commands do not require project scope (epics are cross-project)
3. For `remove`: show item title and confirm with user before dispatching
4. Dispatch tracker agent with: parsed command, resolved project scope (include `--project <key>` if session project context is active), and today's date
5. Display tracker output

## Flag Management

```
PATCH /api/work-items/:id/input-needed    Set or clear the input_needed flag
  body: {"set": true, "question": "What should the retry limit be?"}   (set)
  body: {"set": false}                                                  (clear)

POST /api/work-items/:id/approvals        Add an approver
  body: {"approver": "<name>", "sequential": false}

PATCH /api/work-items/:id/approvals/:id   Resolve an approval
  body: {"resolution": "approved" | "rejected"}
```

- `input_needed` blocks all forward state transitions until cleared
- `approval_active` is set automatically when an approver is added; cleared when all approvals resolve
- Rejecting an approval returns the item to the previous state
- Use `?awaiting_action=true` on list/filter endpoints to see only flagged items

## Dependency Subcommands

```
/work depend <W-XXX> <W-YYY> [W-ZZZ ...]   Add dependencies (W-XXX depends on W-YYY, W-ZZZ)
/work undepend <W-XXX> <W-YYY> [W-ZZZ ...]  Remove dependencies
```

- Cycle detection runs before adding each dependency (DFS from target back to source)
- Cross-project dependencies are allowed (IDs are globally unique)
- Tracker suggests `blocked` status when deps are unfinished but does not auto-change

## Epic Subcommands

```
/work epic list [--status X]
/work epic create <title> [--priority X] [--target YYYY-MM-DD] [--tags a,b]
/work epic show <E-XXX>
/work epic update <E-XXX> <status>
/work epic link <E-XXX> <W-XXX> [W-YYY ...]
/work epic unlink <E-XXX> <W-XXX>
/work epic log <E-XXX> <message>
/work epic plan <E-XXX> [--edit]
/work epic doc <E-XXX> [--edit]
```

## Work Item Artifact Subcommands

```
/work plan <W-XXX> [--edit]                Read or write plan for a work item
/work docs <W-XXX> [--edit]                Read or write documentation for a work item
/work files <W-XXX>                        List all artifact files for a work item
/work file <W-XXX> <filename> [--edit]     Read or write a specific artifact file (.md only)
```

- Artifacts stored at `work/items/W-XXX/` (plan.md, docs.md, plus custom .md files) — created lazily
- Same pattern as epic plan/doc commands
- `files` lists all artifacts with sizes; `file` operates on any `.md` file in the directory
- `show` includes artifact listing when the directory exists

## Post-conditions
- `work/backlog.json` is the primary file modified
- Tracker also writes `work/epics/E-XXX/plan.md` and `work/epics/E-XXX/docs.md` for epic plan/doc commands
- Tracker also writes `work/items/W-XXX/*.md` for work item plan/docs/file commands
- Items are nested under `projects[key].items` — no flat array
- Epics are stored in the top-level `epics` array
- IDs are globally unique and never reused (see `domain/rules.md` → Work Item Rules, Epic Rules)
- All writes preserve existing items, project groups, and epics
