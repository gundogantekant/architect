---
name: pr
description: Create a pull request with automated review summary
user_invocable: true
arguments:
  - name: base-branch
    description: Base branch to target (default: main)
    required: false
---

# /pr

Create a pull request with an automated review summary.

## Steps

1. Follow `usecases/load-portfolio-context.md` (only org conventions needed; fallback: proceed without prefix enforcement)

2. Follow `usecases/create-pr.md` with base-branch from `$ARGUMENTS.base-branch`

## Constraints

- Never push to main directly
- Always create feature/fix branches
- Do not skip pre-commit hooks
- Do not amend existing commits
