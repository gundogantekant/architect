# Dispatch Pipeline

The dispatch pipeline implements autonomous work item execution. When a work item is dispatched from the dashboard, the server spawns a Claude Code subprocess (`claude -p --output-format stream-json`) that reads the work item, plans, implements, tests, and commits — end to end — without human interaction in the main session. The main session (orchestrator) retains its conversation; the spawned agent does all implementation.

---

## Trigger Path

```
POST /api/dispatch
  → validate request (project_key, work_item_id or additional_instructions)
  → load portfolio context + work item in parallel
  → validateContractForComplexity()      # reject 422 if medium+ and contract incomplete
  → shouldCreateWorktree()               # creates worktree if worktree_at_dispatch pref is set
  → buildDispatchPrompt() / buildAutoImplementPrompt()
  → spawn(CLAUDE_BIN, ['-p', '--output-format', 'stream-json', '--verbose'])
  → wireDispatchHandlers(dispatch, proc) # attaches stdout/stderr/close handlers
  → saveDispatchToDb(dispatch)
  → stream JSONL to work/logs/D-<timestamp>.jsonl
```

Key functions:

| Function | File | Purpose |
|---|---|---|
| `validateContractForComplexity` | `routes/dispatch.mjs` | Enforces contract completeness for medium+ work items |
| `buildDispatchPrompt` | `prompt-builder.mjs` | Assembles the full agent prompt |
| `wireDispatchHandlers` | `dispatch-manager.mjs` | Attaches stdout/stderr parsing, log writing, and close handling |
| `saveDispatchToDb` | `state.mjs` | Persists dispatch record to PostgreSQL `dispatches` table |

The spawned process receives the prompt on stdin. The server writes each stdout line as JSONL to `work/logs/D-xxx.jsonl` and broadcasts it to connected SSE/WebSocket clients.

---

## Agent Phase State Machine

`derivePhase(currentPhase, evt)` in `dispatch-manager.mjs` maps stream-json events to the current agent phase. New dispatches seed with `'generating'`.

```
           ┌─────────────────────────────────────┐
           │                                     │
    start  │    content_block_delta (text)        │
      ↓    ↓         from tool_running            │
  generating ───────────────────────────────────┐ │
      │                                         │ │
      │  content_block_start (tool_use)          │ │
      │  OR stop_reason = tool_use               │ │
      ↓                                         │ │
  tool_running ────────────────────────────────►┘ │
      │                                           │
      │  stop_reason = end_turn                   │
      ↓                                           │
  waiting_for_input ────────────────────────────►─┘
      │
      │  result event
      ↓
    null  (terminal)
```

Phase values:

| Phase | Meaning |
|---|---|
| `generating` | Agent is producing text output |
| `tool_running` | A tool call is in flight |
| `waiting_for_input` | Agent reached `end_turn`; paused |
| `null` | Terminal state or phase unknown |

`agent_phase` is ephemeral — held in memory only, not persisted to PostgreSQL. On log replay (restart survival), phase is re-derived by replaying all stored JSONL events through `derivePhase`.

---

## Pipeline Stages

Pipeline stages track semantic progress through the implementation workflow. The agent sets them via `PUT /api/dispatch/:id/stage` at each major transition. The value is stored in the `dispatches.pipeline_stage` column.

```
investigating → implementing → testing → code_review → committing
```

| Stage | Agent action |
|---|---|
| `investigating` | Reading files, understanding change surface |
| `implementing` | Active code changes via coder agent |
| `testing` | Running/writing tests via tester agent |
| `code_review` | Tech Review Board (code gate) running |
| `committing` | git-ops agent committing in worktree |

Stage is `null` for standard (non-auto) dispatches or before the first stage is set.

---

## Completion Flow

After the commit succeeds, the agent calls:

```bash
curl -s -X POST http://127.0.0.1:${PORT}/api/dispatch/${DISPATCH_ID}/complete \
  -H 'Content-Type: application/json' \
  -H 'X-Architect-Session-Depth: 1' \
  -d '{"sha": "<commit-sha>", "summary": "<one-line summary>"}'
```

Server-side flow on `POST /api/dispatch/:id/complete`:

```
receive AutonomousCompletionPayload { sha, summary }
  → validate: X-Architect-Session-Depth must be 1
  → for medium+ complexity: reject if code_gate_passed !== true
  → set dispatch.status = 'merge_pending'
  → set dispatch._mergeHandled = true  (prevents close handler from overwriting status)
  → saveDispatchToDb()
  → if merge_gate pref = 'auto': call triggerMerge() immediately
  → if merge_gate pref = 'confirm': surface in UI; user clicks Merge
```

`triggerMerge()` calls `merge.mjs`, which:
1. Runs `git merge` in the worktree (fast-forward preferred, merge commit fallback).
2. On conflict: sets status to `merge_conflict`; worktree is preserved for manual resolution.
3. On success: removes worktree and branch, updates work item status to `done`, writes session log entry, sets dispatch status to `completed`.

---

## Gate System

Two review board gates bracket implementation. Both use context-filtered board composition (3–10 agents from the tech-reviewer-* pool).

### Plan Gate

Runs after the agent produces an implementation plan, before coding starts. Evaluates `DispatchPlan` against architecture, PM, and SWE criteria.

- Board dispatched in parallel with `artifact_type: plan`
- Any `block` verdict → revise plan, re-review (max 2 cycles)
- All `approve` → set `plan_gate_passed = true`, `plan_gate_passed_at = now`
- Gate failure after 2 cycles → dispatch fails

### Code Gate

Runs after tests pass, before commit. Board evaluates the implementation diff plus the `DispatchContract` to confirm success criteria are met.

- Board dispatched in parallel with `artifact_type: diff`
- Any `block` → dispatch coder to fix, re-review (max 2 cycles)
- All `approve` → set `code_gate_passed = true`
- `contract_satisfied` is set `true` when all `e2e_test_criteria` entries are confirmed passing

For medium+ complexity dispatches: `POST /api/dispatch/:id/complete` is rejected unless `code_gate_passed === true`.

### Gate Fields (DispatchRequest)

```
plan_gate_passed       boolean | null  — null until plan gate runs
plan_gate_passed_at    ISO 8601 | null
code_gate_passed       boolean | null  — null until code gate runs
code_gate_passed_at    ISO 8601 | null
contract_satisfied     boolean | null  — null until e2e criteria confirmed
contract_satisfied_at  ISO 8601 | null
```

---

## Restart Survival

`restoreSessions()` in `dispatch-manager.mjs` is called at server startup. It queries PostgreSQL for all persisted dispatches and terminals, then applies liveness-based recovery.

### Dispatch recovery logic

```
status = 'merge_pending'   → load into memory; trigger auto-merge if pref='auto'
status = 'suspended'       → load into memory, no process
status = 'running' + pid alive  → reconnect via tailLogFile(); log replay re-derives agent_phase
status = 'running' + pid dead   → mark 'interrupted', archive session, load log content for display
status = completed/failed/killed/interrupted → load into memory with log content for display
```

`tailLogFile()` polls the JSONL file on a 2-second interval, replays new lines through `derivePhase`, and broadcasts to connected WebSocket clients. If the PID dies during tailing, the interval clears and status transitions to `interrupted`.

Legacy dispatches without a stored PID are bulk-marked `interrupted` by `markRunningAsInterrupted()` before individual recovery runs.

---

## Operator Runbook

**Start / stop / restart the dashboard server:**
```bash
tools/dashboard/dashctl.sh start
tools/dashboard/dashctl.sh stop
tools/dashboard/dashctl.sh restart
tools/dashboard/dashctl.sh status
```

**Follow server logs:**
```bash
tools/dashboard/dashctl.sh logs -f
```

**Follow a specific dispatch log:**
```bash
tail -f work/logs/D-<timestamp>.jsonl
```

**Kill a running dispatch** (choose one):
- Dashboard UI: click the Kill button on the dispatch panel
- API: `DELETE /api/dispatch/<id>`

**Kill all running sessions:**
- Dashboard UI: "Kill All Sessions" button
- API: `DELETE /api/dispatch/all`

**Inspect dispatch state:**
```bash
curl -s http://127.0.0.1:3777/api/dispatch/active | jq .
curl -s http://127.0.0.1:3777/api/dispatch/<id>/log
```

**Dashboard URL:** `http://127.0.0.1:3777`

**Auto-start via launchd:**
```bash
tools/dashboard/dashctl.sh install    # register launchd service
tools/dashboard/dashctl.sh uninstall  # remove launchd service
```

---

## Key File Reference

| File | Purpose |
|---|---|
| `tools/dashboard/routes/dispatch.mjs` | All dispatch HTTP endpoints |
| `tools/dashboard/dispatch-manager.mjs` | `wireDispatchHandlers`, `derivePhase`, `restoreSessions`, `triggerMerge` |
| `tools/dashboard/prompt-builder.mjs` | Builds full agent prompts from portfolio context + work item |
| `tools/dashboard/merge.mjs` | Worktree merge, conflict handling, cleanup |
| `tools/dashboard/state.mjs` | In-memory maps (`dispatches`, `terminals`) + DB persistence |
| `work/logs/D-xxx.jsonl` | Per-dispatch stream-json output log |
| `usecases/implement-work-item.md` | Full 16-step agent workflow executed inside each dispatch |
| `domain/entities.md` | `DispatchRequest`, `AutonomousCompletionPayload`, `AgentPhase`, `DispatchContract` schemas |
