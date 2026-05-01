# Use Case: Autonomous Pipeline Protocol

Defines the server-side pipeline lifecycle for `auto_implement` dispatches. This complements `usecases/implement-work-item.md` (agent-side steps 1–12).

## Pipeline Stages

1. **Dispatch created** — `dispatch_mode=auto_implement`, `status=running`, worktree created at `<parent>/W-<id>/`, agent spawned with `--dangerously-skip-permissions`
2. **Agent executes** — runs `implement-work-item.md` steps 1–12 autonomously (no user confirmation pauses)
3. **Completion signal** — agent calls `POST /api/dispatch/:id/complete` with `{sha, summary}` and `X-Architect-Session-Depth: 1` header → dispatch transitions to `status=merge_pending`
4. **Pre-merge gate activates** — behavior determined by `DashboardPreferences.merge_gate`:
   - `confirm`: dashboard UI shows "Merge Now" button; user clicks to proceed
   - `auto`: 10-second countdown then server triggers merge automatically
5. **Merge executes** — server calls `attemptMerge()` in `tools/dashboard/merge.mjs`:
   - Fast-forward merge preferred; falls back to merge commit
   - On success → step 6
   - On conflict → step 7
6. **Success path** — worktree removed (`git worktree remove --force`), branch deleted, `dispatch.status=completed`, work item `status=done`, session log updated
7. **Conflict path** — `dispatch.status=merge_conflict`, worktree preserved intact, user notified via dashboard UI. User options: (a) resolve manually in worktree and re-trigger via `POST /api/dispatch/:id/merge`, or (b) run `/pr` to push branch and open a GitHub PR

## Restart Recovery

When the dashboard server restarts with a `merge_pending` dispatch in PostgreSQL:
- `merge_gate=auto` → merge triggers immediately via `setImmediate` (no 10-second delay — delay is initial UX only)
- `merge_gate=confirm` → dispatch surfaces in UI with "Merge Now" button; no automatic action

## Mid-Merge Crash Recovery

If the server crashes during an active `git merge`:
- On next `attemptMerge` call, the function checks for `.git/MERGE_HEAD` at the project path
- If found: runs `git merge --abort` to clean up the partial merge state, then re-attempts the merge
- This makes `attemptMerge` safe to call idempotently after a crash

## Failure Paths

| Failure | Dispatch Status | Work Item Status | Worktree |
|---------|----------------|-----------------|---------|
| Agent never calls POST /complete (exits 0) | `completed` (+ UI badge) | `in-progress` | removed |
| Agent calls POST /complete with outcome failed | `failed` | `in-progress` | preserved |
| Merge conflict | `merge_conflict` | `in-progress` | preserved |
| Agent process crash (exit non-0) | `failed` | `in-progress` | preserved |

No automatic retry on any failure path. User decides next action.

## Cancel Auto-Merge

To cancel a pending auto-merge timer before it fires:
```
POST /api/dispatch/:id/merge/cancel
```
Dispatch remains in `merge_pending`. User can still trigger merge manually:
```
POST /api/dispatch/:id/merge
```

## Completion Signal Contract

- **Endpoint**: `POST /api/dispatch/:id/complete`
- **Required header**: `X-Architect-Session-Depth: 1` (agent-only; returns 403 for depth 0)
- **Body**: `{ "sha": "<commit-sha>", "summary": "<one-line summary>" }`
- **On 404**: dispatch not found
- **On 400**: dispatch not in `running` status
- **On 200**: `{ "status": "merge_pending", "dispatch_id": "<id>" }`

Manual merge trigger (UI/human only):
- **Endpoint**: `POST /api/dispatch/:id/merge`
- **Required**: depth 0 only (returns 403 for depth ≥ 1)
- **On 400**: dispatch not in `merge_pending` status

## Relationship to Domain Rules

See `domain/rules.md` → Autonomous Pipeline Rules for the canonical business rules governing this use case.
