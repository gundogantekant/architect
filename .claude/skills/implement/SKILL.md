---
name: implement
description: Implement a tracked work item end-to-end: investigate, plan, code, test, commit, update status
user_invocable: true
arguments:
  - name: id
    description: "Work item ID (W-XXX format)"
    required: true
---

# /implement

Implement a tracked work item through the full cycle: fetch details, investigate, plan with user confirmation, code, test, commit, and update status.

## Agents Dispatched
- **coder** (inherit) — implementation and commit
- **tester** (sonnet) — test verification
- **tracker** (haiku) — status update

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **standard** (fallback: run scout to detect the stack)
2. Follow `usecases/implement-work-item.md` with work item ID from `$ARGUMENTS.id`

## Output
- Implementation changes committed in a worktree branch
- Test results summary
- Work item status updated to `done`
- Commit hash and branch name for follow-up (`/pr` or `/worktree cleanup`)
