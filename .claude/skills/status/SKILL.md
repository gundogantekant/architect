---
name: status
description: Project health dashboard showing deps, coverage, TODOs, and CI status
user_invocable: true
---

# /status

Generate a project health dashboard.

## Steps

1. **Load portfolio context**:
   - Resolve the target project path (from cwd or arguments)
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/<project>/<component>.json` and `portfolio/<org>/organization.json`
   - If not found: fall back to running the **scout** agent (model: haiku) to scan the project

2. Use the **dependency-manager** agent (model: haiku) to:
   - Check for outdated dependencies
   - Report security vulnerabilities in dependencies

3. Gather additional health metrics:
   - Count TODO/FIXME/HACK tags in codebase using Grep
   - Check git status (uncommitted changes, branch state)
   - Check CI status if GitHub Actions configured (using gh CLI)
   - Check test coverage if available

4. Compile into a health dashboard

## Output

### Project Health Dashboard

**Stack**: detected stack summary
**Dependencies**: X total, Y outdated, Z vulnerable
**Code Quality**: X TODOs, Y FIXMEs
**Git Status**: branch, uncommitted changes count
**CI Status**: last run result (if available)
**Test Coverage**: percentage (if available)

**Action Items**: prioritized list of things to address
