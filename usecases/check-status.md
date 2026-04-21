# Use Case: Check Status

Generate a project health dashboard.

## Input
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Health dashboard: stack, dependencies, code quality, git status, CI status, test coverage

## Preconditions
- Follow `usecases/load-portfolio-context.md` (fallback: run scout to scan the project)

## Agent(s)
- **dependency-manager** (model: haiku) — dependency health
- **scout** (model: haiku) — fallback detection

## Steps

### Technical Health

1. Load portfolio context for stack summary
2. Dependency-manager checks: outdated dependencies, security vulnerabilities
3. Gather additional metrics:
   - Count TODO/FIXME/HACK tags via Grep
   - Check git status (uncommitted changes, branch state)
   - Check CI status via gh CLI (if GitHub Actions configured)
   - Check test coverage (if available)

### Work Item Status (PM Reporting)

4. Retrieve open and in-progress work items for the target project
5. Group by status: open, ready, in-progress, blocked, done, cancelled
6. Identify blocked items and trace their blockers (what dependency or item are they waiting on?)
7. Identify stale items — no status change or session log entry for 7+ days
8. Check for active agent sessions (dispatches and terminals) on this project

### Epic Progress (if applicable)

9. If the project has work items linked to active epics, report per-epic progress: done / total, acceptance criteria coverage

### Cross-Org Summary (if org-level scope)

10. If operating at org level, aggregate across all projects in the org: active items, blocked count, latest activity per project
11. Detect cross-project blockers: blocked items depending on items in other projects with no active dispatch

### Recommendations

12. Compile findings into a health dashboard with prioritized action items
13. Suggest next actions: which blocked items to unblock, which ready items to dispatch, which stale items to review or cancel
14. Flag any escalation triggers (see `domain/rules.md` → PM Behavior Rules → Escalation Triggers)

## Post-conditions
- Dashboard includes technical health metrics and work item status
- Action items are prioritized (escalations first, then blocked items, then stale items, then general recommendations)
