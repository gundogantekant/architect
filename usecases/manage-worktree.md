# Use Case: Manage Worktree

Core worktree lifecycle for isolating implementation agent work from the user's main working tree.

## Actions

- `create` — Create an isolated worktree for implementation work
- `list` — List active worktrees for a project
- `cleanup` — Remove a worktree (merge path or discard path)

## Create

### Input
- Target project path (from portfolio context `source_path`)
- Ticket ID (obtained by orchestrator from Notion MCP or user input)
- Task description (used to derive branch slug)
- Branch prefix (from org conventions, optional)
- Portfolio entry (for `worktree_setup` hooks, optional)

### Steps

1. Receive target project path, ticket ID, and task description
2. Derive `project-dir-name` from the basename of the target project path (e.g., `/Users/user/NeuronicRepos/light-app/main` → `light-app`)
3. Derive branch name: `<project-dir-name>-<branch-prefix><ticket-id>-<slugified-description>` (e.g., `light-app-GEN-1641-add-auth-flow`)
4. Compute worktree path: `<parent-of-project-dir>/<branch-name>/` (sibling of the project folder, e.g., `/Users/user/NeuronicRepos/light-app-GEN-1641-add-auth-flow/`)
5. Run `git worktree add <worktree-path> -b <branch-name>` from the target project
6. If `worktree_setup.copy_paths` is defined in the portfolio entry: copy each path from source to worktree (e.g., `cp -r <source>/<path> <worktree>/<path>`)
7. If `worktree_setup.post_commands` is defined: run each command in the worktree directory
8. Return WorktreeContext (see `domain/entities.md` → WorktreeContext)

### Output
```json
{
  "worktree_path": "/abs/path/to/parent/light-app-GEN-1641-add-auth-flow",
  "source_path": "/abs/path/to/parent/light-app/main",
  "branch_name": "light-app-GEN-1641-add-auth-flow",
  "ticket_id": "GEN-1641"
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
  - `architect`: sibling folder matching `<project-dir-name>-*` pattern (created by architect)
  - `external`: worktree elsewhere (created manually or by other tools)

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
- Sibling worktree directory is removed
- Branch is deleted (discard) or preserved for PR (merge)
