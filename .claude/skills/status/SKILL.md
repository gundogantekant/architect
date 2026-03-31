---
name: status
description: Project health dashboard showing deps, coverage, TODOs, and CI status
execution: inline
user_invocable: true
---

# /status

Generate a project health dashboard.

## Agents Dispatched
- **dependency-manager** (haiku) — dependency health
- **scout** (haiku) — fallback detection

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: run scout to scan the project)

2. Follow `usecases/check-status.md`

## Output

### Project Health Dashboard

**Stack**: detected stack summary
**Dependencies**: X total, Y outdated, Z vulnerable
**Code Quality**: X TODOs, Y FIXMEs
**Git Status**: branch, uncommitted changes count
**CI Status**: last run result (if available)
**Test Coverage**: percentage (if available)

**Action Items**: prioritized list of things to address
