---
name: onboard
description: Scan a project and register it in the architect portfolio
execution: dispatch
user_invocable: true
arguments:
  - name: path
    description: Path to the project to onboard
    required: true
  - name: organization
    description: "Organization name (auto-detected from path if under a known org's path_root)"
    required: false
  - name: rescan
    description: "Set to 'rescan' to refresh an existing profile's scout report"
    required: false
---

# /onboard

Scan a project's tech stack, analyze its purpose and architecture, and register it in the architect portfolio.

## Agents Dispatched
- **scout** (haiku) — technology detection
- **profiler** (sonnet) — project analysis, brief generation, CLAUDE.md generation

## Steps

Follow `usecases/onboard-project.md` with:
- path from `$ARGUMENTS.path`
- organization from `$ARGUMENTS.organization` (optional)
- rescan from `$ARGUMENTS.rescan` (optional)

See `domain/entities.md` → ScoutReport, ProjectBrief, PortfolioEntry, Organization for output schemas.

## Output

- Detection report (JSON)
- Project brief (JSON) with purpose, domain, constraints, and architecture analysis
- CLAUDE.md written to the target project root
- doc_paths array of documentation files found in the target project
- Component profile written to portfolio
- Registry updated
