# Use Case: Manage Worktree

Core worktree lifecycle for isolating implementation agent work from the user's main working tree.

## Actions

- `create` — Create an isolated worktree for implementation work
- `list` — List active worktrees for a project
- `cleanup` — Remove a worktree (merge path or discard path)

## Create

### Input
- Target project path (from portfolio context `source_path`)
- Task description (used to derive branch name)
- Branch prefix (from org conventions, optional)

### Steps

1. Receive target project path and task description
2. Derive branch name: apply org's `branch_prefix` convention if available, slugify the task description (e.g., `feat/add-auth-middleware`)
3. Run `git worktree add <project>/.worktrees/<branch> -b <branch>` from the target project
4. Add `.worktrees/` to target project's `.gitignore` if not already present
5. Return WorktreeContext (see `domain/entities.md` → WorktreeContext)

### Output
```json
{
  "worktree_path": "/abs/path/to/project/.worktrees/<branch>",
  "source_path": "/abs/path/to/project",
  "branch_name": "<branch>"
}
```

## List

### Input
- Target project path

### Steps

1. Run `git worktree list` in the target project
2. Show all worktrees (do not filter by location)
3. Return list of active worktrees with branch names, paths, and origin

### Output
- Table of worktree path, branch name, HEAD commit, and origin (`main` / `architect` / `external`)
  - `main`: the primary working tree
  - `architect`: worktree under `<project>/.worktrees/` (created by architect)
  - `external`: worktree outside `<project>/.worktrees/` (created manually or by other tools)

## Cleanup

### Input
- Worktree path or branch name
- Mode: `merge` or `discard`

### Steps

**Merge path** (branch has commits the user wants to keep):
1. User creates PR via `/pr` from the worktree branch
2. After PR is merged or branch is no longer needed: `git worktree remove <path>`
3. Optionally delete the local branch: `git branch -d <branch>`

**Discard path** (changes are unwanted):
1. `git worktree remove --force <path>`
2. `git branch -D <branch>`

### Post-conditions
- Worktree directory is removed from `<project>/.worktrees/`
- Branch is deleted (discard) or preserved for PR (merge)
