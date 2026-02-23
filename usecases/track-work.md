# Use Case: Track Work

Manage persistent work items across sessions.

## Input
- Subcommand: list, add, show, update, log, remove
- Arguments per subcommand (see `domain/entities.md` → WorkItem for schema)

## Output
- Work item listing, details, or confirmation of changes

## Agent(s)
- **tracker** (model: haiku, data-write)

## Steps

1. Parse command and arguments
2. For `add` without `--project`: auto-resolve project from cwd via `portfolio/registry.json`
3. For `remove`: show item title and confirm with user before dispatching
4. Dispatch tracker agent with parsed command and today's date
5. Display tracker output

## Post-conditions
- `work/backlog.json` is the only file modified
- IDs are never reused (see `domain/rules.md` → Work Item Rules)
- All writes preserve existing items
