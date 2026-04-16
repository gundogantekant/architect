---
name: review-board
description: Manually trigger the Technical Review Board on a plan or code diff
execution: dispatch
user_invocable: true
arguments:
  - name: gate
    description: "Gate to run: 'plan' (reviews a plan artifact) or 'code' (reviews code changes)"
    required: true
  - name: scope
    description: "For code gate: 'staged', 'branch', or file paths. For plan gate: 'W-XXX' work item ID or a file path to a plan .md file. Defaults to staged diff (code) or changed .md files on branch (plan)."
    required: false
---

# /review-board

Trigger the Technical Review Board in isolation on any artifact — a plan document or a code diff — without going through the full `/implement` or `/pr` lifecycle.

## Agents Dispatched

**Always included (3)**:
- `tech-reviewer-swe` (sonnet) — code quality, testability, tech debt
- `tech-reviewer-arch` (sonnet) — Clean Architecture, layer boundaries, structural soundness
- `tech-reviewer-pm` (sonnet) — scope alignment, risk, milestone impact

**Context-dependent (up to 7)**:
- `tech-reviewer-frontend` — when project has frontend stack or artifact touches UI
- `tech-reviewer-ux` — when project has user-facing interfaces or artifact introduces user flows
- `tech-reviewer-dx` — when project has developer-facing surfaces or artifact changes developer APIs
- `tech-reviewer-dba` — when project uses a database or artifact touches schema/query/model code
- `tech-reviewer-systems` — when project spans multiple subsystems or artifact crosses system boundaries
- `tech-reviewer-iot` — when project involves IoT/embedded or artifact touches device-layer code
- `tech-reviewer-prod` — when project has backend services or artifact introduces new deployment units

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: proceed without portfolio context, rely on artifact scanning for board composition)

2. Follow `usecases/run-review-board.md` with:
   - `gate` from `$ARGUMENTS.gate`
   - `scope` from `$ARGUMENTS.scope` (may be empty)

## Output

- Board composition: which agents were selected and why
- Individual `TechReviewVerdict` from each reviewer (approve / revise / block + rationale)
- Aggregated `TechReviewBoardResult` with recommended next action
