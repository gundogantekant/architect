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
  - name: from_remote
    description: "GitHub repo name (e.g. 'my-org/my-repo'). When set, step 0 from the usecase resolves the local path via GET /api/repos before proceeding with standard onboarding."
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
- When `$ARGUMENTS.from_remote` is set: prepend step 0 from the usecase's "Onboard from Remote" section to resolve the local path before proceeding

See `domain/entities.md` → ScoutReport, ProjectBrief, PortfolioEntry, Organization for output schemas.

## Output

- Detection report (JSON)
- Project brief (JSON) with purpose, domain, constraints, and architecture analysis
- CLAUDE.md written to the target project root
- doc_paths array of documentation files found in the target project
- Component profile written to portfolio
- Registry updated
