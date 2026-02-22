---
name: status
description: Project health dashboard showing deps, coverage, TODOs, and CI status
user_invocable: true
---

# /status

Generate a project health dashboard.

## Steps

1. Use the **scout** agent (model: haiku) to scan the project:
   - Detect tech stack and configuration
   - Count source files and lines of code

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
