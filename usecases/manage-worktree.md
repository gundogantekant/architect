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
5. Capture originating branch: `git rev-parse --abbrev-ref HEAD` in the target project (store as `originating_branch`)
6. Run `git worktree add <worktree-path> -b <branch-name>` from the target project
7. If `worktree_setup.copy_paths` is defined in the portfolio entry: copy each path from source to worktree (e.g., `cp -r <source>/<path> <worktree>/<path>`)
8. If `worktree_setup.post_commands` is defined: run each command in the worktree directory
9. Return WorktreeContext (see `domain/entities.md` → WorktreeContext)

### Output
```json
{
  "worktree_path": "/abs/path/to/parent/light-app-GEN-1641-add-auth-flow",
  "source_path": "/abs/path/to/parent/light-app/main",
  "branch_name": "light-app-GEN-1641-add-auth-flow",
  "ticket_id": "GEN-1641",
  "originating_branch": "main"
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
- Mode: `merge` (PR, default), `merge-back` (local), or `discard`

### Steps

**Merge path (PR — default)** — branch has commits the user wants to share via pull request:
1. User creates PR via `/pr` from the worktree branch
2. After PR is merged or branch is no longer needed: `git worktree remove <path>`
3. Optionally delete the local branch: `git branch -d <branch>`

**Merge-back path (local)** — branch is approved and ready to merge locally into the originating branch:
1. Pre-flight: verify the worktree branch has commits ahead of originating branch (`git log <originating>..<branch> --oneline`)
2. Pre-flight: verify no uncommitted changes in the worktree (`git status --porcelain` in worktree)
3. Pre-flight: verify originating branch still exists (`git rev-parse --verify <originating>`)
4. Switch to source project: `cd <source_path>`
5. Checkout originating branch: `git checkout <originating_branch>`
6. Attempt fast-forward merge: `git merge --ff-only <branch_name>`
7. If fast-forward fails (originating branch diverged): `git merge --no-ff <branch_name> -m "Merge <branch_name> into <originating_branch>"`
8. If conflict: `git merge --abort`. Report conflicting files to user. Do NOT auto-resolve.
9. Remove worktree: `git worktree remove <path>`
10. Delete branch: `git branch -d <branch>`
11. If dashboard API available: log merge to work item session log

**Discard path** (changes are unwanted):
1. `git worktree remove --force <path>`
2. `git branch -D <branch>`

### Post-conditions
- Sibling worktree directory is removed
- Branch is deleted (discard/merge-back) or preserved for PR (merge)
