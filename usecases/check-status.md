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

1. Load portfolio context for stack summary
2. Dependency-manager checks: outdated dependencies, security vulnerabilities
3. Gather additional metrics:
   - Count TODO/FIXME/HACK tags via Grep
   - Check git status (uncommitted changes, branch state)
   - Check CI status via gh CLI (if GitHub Actions configured)
   - Check test coverage (if available)
4. Compile into health dashboard

## Post-conditions
- Dashboard includes prioritized action items
