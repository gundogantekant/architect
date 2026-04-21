# Use Case: Run Review Board

Trigger the Technical Review Board on a plan or code artifact in isolation. Assembles the board using context-based composition rules, dispatches all selected reviewers in parallel, and aggregates their verdicts.

## Input

- `gate`: `plan` | `code`
- `scope` (optional):
  - `plan` gate: `W-XXX` work item ID, a file path to a `.md` plan file, or empty
  - `code` gate: `staged`, `branch`, file path(s), or empty
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output

- Board composition with inclusion rationale per agent
- Individual `TechReviewVerdict` per reviewer
- Aggregated `TechReviewBoardResult`

## Preconditions

- Follow `usecases/load-portfolio-context.md` (fallback: proceed without context, use artifact scanning)

## Agent(s)

- `tech-reviewer-swe`, `tech-reviewer-arch`, `tech-reviewer-pm` — always dispatched (model: sonnet, read-only)
- `tech-reviewer-frontend`, `tech-reviewer-ux`, `tech-reviewer-dx`, `tech-reviewer-dba`, `tech-reviewer-systems`, `tech-reviewer-iot`, `tech-reviewer-prod` — context-dependent (model: sonnet, read-only)

## Steps

1. **Determine the artifact** based on `gate` + `scope`:

   | Gate | Scope | Artifact source |
   |------|-------|-----------------|
   | `plan` | `W-XXX` | `GET /api/work-items/{id}/plan` via dashboard API |
   | `plan` | file path | Read file directly |
   | `plan` | empty | `git diff main...HEAD -- "*.md"` — collect changed plan files on branch |
   | `code` | `staged` or empty | `git diff --cached` |
   | `code` | `branch` | `git diff main...HEAD` |
   | `code` | file path(s) | Read the specified files |

   If the artifact resolves to empty (no diff, no plan file found), surface an error to the user describing what was attempted.

2. **Set artifact type** for downstream use:
   - `gate=plan` → `artifact_type=plan`
   - `gate=code` → `artifact_type=diff`

3. **Assemble the board** using the context-based composition rules from `domain/rules.md` → Review Board Rules:
   - Check portfolio entry (`scout_report.language`, `scout_report.framework`, `guidance.stack_summary`, tags)
   - Scan artifact content for keywords/patterns matching optional reviewer triggers
   - When portfolio entry is missing or inconclusive, fall back to artifact content scanning
   - When both are inconclusive for an optional reviewer, include it (over-inclusion is cheaper than a missed perspective)
   - Record inclusion rationale for each selected agent

4. **Dispatch all selected `tech-reviewer-*` agents in parallel**, each receiving:
   - The artifact content
   - The `artifact_type`
   - Portfolio context (full depth, or what was loaded)
   - The gate being run (`plan` or `code`)

5. **Collect `TechReviewVerdict`** from each agent. Each verdict contains:
   - `verdict`: `approve` | `revise` | `block`
   - `concerns`: list of specific findings with references
   - `rationale`: summary of the verdict decision

6. **Apply aggregation rules** from `domain/rules.md` → Review Board Rules → Aggregation Rules:

   | Condition | Result |
   |-----------|--------|
   | Any verdict is `block` | Artifact does NOT proceed. Present all block concerns grouped by reviewer. Suggest next step: revise the plan/code and re-run `/review-board`. |
   | Any verdict is `revise` (none `block`) | Present all revision concerns grouped by reviewer. User decides: accept as-is, request revision, or override. |
   | All verdicts are `approve` | Board passes. Present approval summary. |

7. **Present output**:
   - Board composition table: agent | included | rationale
   - Verdict table: agent | verdict | summary of concerns
   - Aggregated result with recommended next action

## Post-conditions

- All findings reference specific locations (file:line for code, section for plan documents)
- Board composition rationale is always shown so the user understands which reviewers were selected and why
- No code changes are made — this use case is read-only
