---
name: status
description: Project health and PM dashboard showing deps, coverage, work items, dispatches, and escalations
execution: inline
user_invocable: true
---

# /status

Generate a project health and work status dashboard.

## Agents Dispatched
- **dependency-manager** (haiku) — dependency health
- **scout** (haiku) — fallback detection

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: run scout to scan the project)

2. Follow `usecases/check-status.md` (includes both technical health and PM reporting steps)

## Output

### Project Health Dashboard

**Stack**: detected stack summary
**Dependencies**: X total, Y outdated, Z vulnerable
**Code Quality**: X TODOs, Y FIXMEs
**Git Status**: branch, uncommitted changes count
**CI Status**: last run result (if available)
**Test Coverage**: percentage (if available)

### Work Item Status

**Work Items**: X open, Y in-progress, Z blocked, W done
**Active Dispatches**: N running agents on this project
**Blocked Items**: list with blockers identified
**Stale Items**: items with no activity for 7+ days

### Epic Progress (if applicable)

**Epic [E-XXX]**: title — N/M items done, acceptance criteria coverage

### Escalations

Any active escalation triggers (stale, blocked-chain, epic-stall, dispatch-loop, cost-anomaly) per `domain/rules.md` → PM Behavior Rules.

### Action Items

Prioritized list: escalations first, then blocked items to unblock, then ready items to dispatch, then stale items to review
