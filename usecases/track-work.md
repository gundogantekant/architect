# Use Case: Track Work

Manage persistent work items and epics across sessions. Items are grouped by project key in `work/backlog.json`. Epics are top-level cross-project groupings.

## Input
- Subcommand: list, add, show, update, log, remove, depend, undepend
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
   - If no `--project` and no `--org` and cwd is inside a known project, auto-resolve via `portfolio/registry.json` to get the `org/project/component` key
   - For `list` without project context: show cross-project summary (all projects)
   - Epic commands do not require project scope (epics are cross-project)
3. For `remove`: show item title and confirm with user before dispatching
4. Dispatch tracker agent with parsed command, resolved project scope, and today's date
5. Display tracker output

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

## Post-conditions
- `work/backlog.json` is the primary file modified
- Tracker also writes `work/epics/E-XXX/plan.md` and `work/epics/E-XXX/docs.md` for epic plan/doc commands
- Items are nested under `projects[key].items` — no flat array
- Epics are stored in the top-level `epics` array
- IDs are globally unique and never reused (see `domain/rules.md` → Work Item Rules, Epic Rules)
- All writes preserve existing items, project groups, and epics
