# Use Case: Onboard Project

Scan a project and register it in the architect portfolio.

## Input
- Target project path
- Organization name (optional, auto-detected from path)
- Rescan flag (optional, refreshes existing profile)

## Output
- ScoutReport (see `domain/entities.md` → ScoutReport)
- PortfolioEntry written to `portfolio/<org>/<project>/<component>.json`
- Registry updated in `portfolio/registry.json`

## Agent(s)
- **scout** (model: haiku) — technology detection

## Steps

1. Read `portfolio/registry.json` — check if path already exists
   - If found and no rescan: display existing profile and exit
   - If found and rescan: proceed (will archive and update)
2. Detect organization:
   - Read all `portfolio/*/organization.json` files
   - Match by provided org name, or by path_root prefix
   - If no match: ask user to create new org or skip org association
3. Run scout agent to produce ScoutReport (see `domain/entities.md` → ScoutReport)
4. Determine recommended agents based on scout report:
   - All projects: coder, tester, reviewer, debugger, documenter, dependency-manager
   - Frontend → add coder-frontend; Backend → add coder-backend; Mobile → add coder-mobile
   - CI present → add ci-cd; Containers present → add coder-infra
5. Derive project and component names from path
6. Build PortfolioEntry (see `domain/entities.md` → PortfolioEntry)
   - For rescans: archive current profile as `<component>.<date>.json`
7. Present for user approval
8. Write component profile and update registry

## Post-conditions
- No files written to the target project
- Portfolio entry is accessible via `usecases/load-portfolio-context.md`
