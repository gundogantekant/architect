# Use Case: Manage Worktree

Core worktree lifecycle for isolating implementation agent work from the user's main working tree.

## Actions

- `create` — Create an isolated worktree for implementation work
- `list` — List active worktrees for a project
- `cleanup` — Remove a worktree (merge path or discard path)

## Create

### Input
- Target project path (from portfolio context `source_path`)
- Ticket ID (W-XXX — from the work item; used as the branch and directory name)
- Portfolio entry (for `worktree_setup` hooks, optional)

### Steps

1. Receive target project path and ticket ID (W-XXX format from the work item)
2. Derive branch name: `W-<id>` (e.g., `W-933`)
3. Compute worktree path: `<parent-of-project-dir>/W-<id>/` (sibling of the project folder, e.g., `/Users/user/NeuronicRepos/W-933/`)
4. Capture originating branch: `git rev-parse --abbrev-ref HEAD` in the target project (store as `originating_branch`)
5. Run `git worktree add <worktree-path> -b <branch-name>` from the target project
6. If `worktree_setup.copy_paths` is defined in the portfolio entry: copy each path from source to worktree (e.g., `cp -r <source>/<path> <worktree>/<path>`)
7. If `worktree_setup.post_commands` is defined: run each command in the worktree directory
8. Return WorktreeContext (see `domain/entities.md` → WorktreeContext)

### Output
```json
{
  "worktree_path": "/abs/path/to/parent/W-933",
  "source_path": "/abs/path/to/parent/light-app/main",
  "branch_name": "W-933",
  "ticket_id": "W-933",
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
  - `architect`: sibling folder matching `W-*` pattern (created by architect)
  - `external`: worktree elsewhere (created manually or by other tools)

## Cleanup

### Input
- Worktree path or branch name
- Mode: `merge-back` (local, default — merge into originating branch and clean up), `pr` (push branch and create GitHub PR), or `discard` (abandon changes)

### Steps

**PR path (explicit)** — branch has commits the user wants to share via GitHub pull request:
1. User creates PR via `/pr` from the worktree branch
2. After PR is merged or branch is no longer needed: `git worktree remove <path>`
3. Optionally delete the local branch: `git branch -d <branch>`

**Merge-back path (local, default)** — branch is approved and ready to merge locally into the originating branch:
1. Pre-flight: verify the worktree branch has commits ahead of originating branch (`git log <originating>..<branch> --oneline`)
2. Pre-flight: verify no uncommitted changes in the worktree (`git status --porcelain` in worktree)
3. Pre-flight: verify originating branch still exists (`git rev-parse --verify <originating>`)
4. Switch to source project: `cd <source_path>`
5. Checkout originating branch: `git checkout <originating_branch>`
6. Attempt fast-forward merge: `git merge --ff-only <branch_name>`
7. If fast-forward fails (originating branch diverged): `git merge --no-ff <branch_name> -m "Merge <branch_name> into <originating_branch>"`
8. If conflict: dispatch coder agent to attempt resolution — it must (a) identify the conflicting hunks, (b) produce a resolution, and (c) provide an impact analysis (what changed semantically, risk level). If the resolution is clean and low-risk, apply it and complete the merge. If the conflict cannot be meaningfully resolved (risk too high, intent unclear, or multiple overlapping changes), run `git merge --abort`, preserve the worktree intact, report the conflicting files with a brief conflict summary, and offer two options: (a) run `/pr` to push a pull request instead, or (b) leave the worktree open for manual resolution. Do not proceed past this step on unresolved conflict.
9. Remove worktree: `git worktree remove <path>`
10. Delete branch: `git branch -d <branch>`
11. If dashboard API available: log merge to work item session log

**Discard path** (changes are unwanted):
1. `git worktree remove --force <path>`
2. `git branch -D <branch>`

### Post-conditions
- Sibling worktree directory is removed
- Branch is deleted (discard/merge-back) or preserved for PR (merge)
