---
name: worktree
description: List and clean up git worktrees created for implementation isolation
user_invocable: true
arguments:
  - name: action
    description: "Action to perform: list or cleanup"
    required: true
---

# /worktree

Manage git worktrees used to isolate implementation agent work.

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **minimal** (fallback: use cwd as project path)

2. Follow `usecases/manage-worktree.md` with action from `$ARGUMENTS.action`:
   - **list**: Show active worktrees for the target project
   - **cleanup**: Prompt user for merge or discard, then remove the worktree

## Output

- **list**: Table of active worktrees with branch names and paths
- **cleanup**: Confirmation of worktree removal and branch status
