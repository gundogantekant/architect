---
name: review
description: Comprehensive code review of staged changes, branch diff, or specific files
user_invocable: true
arguments:
  - name: scope
    description: "Review scope: 'staged' for staged changes, 'branch' for branch diff, or file paths"
    required: false
---

# /review

Run a comprehensive code review.

## Steps

1. Follow `usecases/load-portfolio-context.md` (fallback: proceed without portfolio context)

2. Follow `usecases/review-code.md` with scope from `$ARGUMENTS.scope`

## Output

- Structured code review with severity levels
- Specific file:line references for each finding
- Summary assessment
