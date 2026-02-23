---
name: onboard
description: Scan a project and register it in the architect portfolio
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

Scan a project's tech stack and register it in the architect portfolio.

## Steps

Follow `usecases/onboard-project.md` with:
- path from `$ARGUMENTS.path`
- organization from `$ARGUMENTS.organization` (optional)
- rescan from `$ARGUMENTS.rescan` (optional)

See `domain/entities.md` → ScoutReport, PortfolioEntry, Organization for output schemas.

## Output

- Detection report (JSON)
- Component profile written to portfolio
- Registry updated
- No files written to the target project
