# Use Case: Onboard Project

Scan a project, profile its purpose and architecture, and register it in the architect portfolio.

## Input
- Target project path
- Organization name (optional, auto-detected from path)
- Rescan flag (optional, refreshes existing profile)

## Output
- ScoutReport (see `domain/entities.md` → ScoutReport)
- ProjectBrief (see `domain/entities.md` → ProjectBrief)
- CLAUDE.md written to the target project root
- doc_paths array of documentation file paths found in the target project
- PortfolioEntry written to `portfolio/<org>/<project>/<component>.json`
- Registry updated in `portfolio/registry.json`

## Agent(s)
- **scout** (model: haiku) — technology detection
- **profiler** (model: sonnet) — project analysis, brief generation, CLAUDE.md generation

## Steps

1. Read `portfolio/registry.json` — check if path already exists
   - If found and no rescan: display existing profile and exit
   - If found and rescan: proceed (will archive and update)
2. Detect organization:
   - Read all `portfolio/*/organization.json` files
   - Match by provided org name, or by path_root prefix
   - If no match: ask user to create new org or skip org association
3. Run scout agent to produce ScoutReport (see `domain/entities.md` → ScoutReport)
4. Run profiler agent to produce ProjectBrief + doc_paths + CLAUDE.md:
   - Pass project path + ScoutReport from step 3
   - If no README/docs exist: profiler produces minimal brief from package manifests and directory names
   - If CLAUDE.md exists in target project: profiler reads it, asks user whether to merge/overwrite/skip
   - Write CLAUDE.md to target project root (unless user chose skip)
5. Determine recommended agents based on scout report:
   - All projects: coder, tester, reviewer, debugger, documenter, dependency-manager
   - Frontend → add coder-frontend; Backend → add coder-backend; Mobile → add coder-mobile
   - CI present → add ci-cd; Containers present → add coder-infra
6. Derive project and component names from path
7. Build PortfolioEntry (see `domain/entities.md` → PortfolioEntry)
   - Include scout_report, brief, and doc_paths
   - For rescans: archive current profile as `<component>.<date>.json`
8. Present for user approval
9. Write component profile and update registry

## Post-conditions
- Only CLAUDE.md is written to the target project
- Portfolio entry is accessible via `usecases/load-portfolio-context.md`
