---
name: review
description: Comprehensive code review of staged changes, branch diff, or specific files
execution: dispatch
user_invocable: true
arguments:
  - name: scope
    description: "Review scope: 'staged' for staged changes, 'branch' for branch diff, or file paths"
    required: false
---

# /review

Run a comprehensive code review.

## Agents Dispatched
- **reviewer** (sonnet) — code review

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: proceed without portfolio context)

2. Follow `usecases/review-code.md` with scope from `$ARGUMENTS.scope`

## Output

- Structured code review with severity levels
- Specific file:line references for each finding
- Summary assessment
