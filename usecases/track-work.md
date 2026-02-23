# Use Case: Track Work

Manage persistent work items across sessions. Items are grouped by project key in `work/backlog.json`.

## Input
- Subcommand: list, add, show, update, log, remove
- Arguments per subcommand (see `domain/entities.md` → WorkItem for schema)

## Output
- Work item listing (grouped by project), details, or confirmation of changes

## Agent(s)
- **tracker** (model: haiku, data-write)

## Steps

1. Parse command and arguments
2. Resolve project scope:
   - If `--project` flag provided, use as project key
   - If no `--project` and cwd is inside a known project, auto-resolve via `portfolio/registry.json` to get the `org/project/component` key
   - For `list` without project context: show cross-project summary (all projects)
3. For `remove`: show item title and confirm with user before dispatching
4. Dispatch tracker agent with parsed command, resolved project scope, and today's date
5. Display tracker output

## Post-conditions
- `work/backlog.json` is the only file modified
- Items are nested under `projects[key].items` — no flat array
- IDs are globally unique and never reused (see `domain/rules.md` → Work Item Rules)
- All writes preserve existing items and project groups
