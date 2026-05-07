# ADR-001: Temporal.io Feasibility for Dispatch Lifecycle Management

## Status
Rejected

## Context

W-964 previously flagged Temporal.io as worth evaluating for the architect dashboard's subprocess management. The current implementation (`tools/dashboard/`) manages Claude Code subprocesses as a self-contained Node.js process with these components:

- **In-memory state**: `dispatches` Map (keyed by dispatch ID) and `terminals` Map in `state.mjs`, holding live process handles, WebSocket client sets, JSONL output buffers, and phase-tracking state.
- **JSONL log replay**: Each dispatch writes raw `stream-json` events to `work/logs/D-xxx.jsonl`. On server restart, `restoreSessions` reads the log file, replays events to reconstruct `agent_phase`, `lastLines`, and the output buffer, then re-opens a polling interval (`tailLogFile`) to track any still-running PIDs via `setInterval` at 2-second ticks.
- **PID polling**: `isPidAlive` is called every 60 seconds in the auto-cleanup loop and on every 2-second tick in `tailLogFile` to detect process death without a close event.
- **PostgreSQL persistence**: The `dispatches` and `terminals` tables store metadata (PID, status, `agent_phase`, `timeout_at`, `contract`, `worktree_path`, etc.). DB is used for cross-restart recovery, not as the primary execution record.
- **tmux sessions**: Interactive terminals are wrapped in tmux. On restart, `restoreSessions` calls `tmuxSessionExists` and re-attaches via `pty.spawn('tmux', ['attach-session', ...])`.
- **Session lifecycle hooks**: `shutdownFlush` runs on SIGTERM/SIGINT; it intentionally leaves surviving PIDs as `status: 'running'` in the DB so they are reconnected on the next startup.

## Decision

Do not migrate the dispatch lifecycle to Temporal.io.

## Rationale

- **PTY and tmux are outside Temporal's execution model.** Temporal workflows execute deterministic, serializable functions. The dashboard's terminal sessions use `node-pty` to produce PTY file descriptors and re-attach them to tmux sessions on restart. PTY handles, file descriptors, and tmux socket connections cannot be serialized into Temporal's event history or carried across worker restarts. The core interactive terminal feature would need to be redesigned completely.

- **The subprocess is external to the worker process.** Temporal's durability model assumes the workflow logic itself is what must survive. Here the durable entity is a spawned `claude` child process whose lifecycle is managed by the OS. The dispatch's handle (`proc.stdout`, `proc.stderr`, close event) exists only inside a single Node.js process. A Temporal activity would need to complete (or fail) before returning control to the workflow, but a Claude Code dispatch runs for minutes to hours with continuous stdout streaming — activity timeouts and heartbeats cannot model this naturally. Long-running activities require explicit heartbeat patterns and are constrained to a single worker; this gives the same failure surface as the current PID polling approach without adding durability.

- **JSONL replay is a workable substitute for event sourcing, at lower cost.** Temporal's event history would replace the JSONL files, but the current replay (`tailLogFile`) already reconstructs all runtime state (`agent_phase`, `lastLines`, `output` buffer) from the log by parsing `stream-json` events deterministically. Adding Temporal would impose a separate Temporal server (or Temporal Cloud), a worker process, and the Temporal SDK dependency to achieve the same outcome the JSONL replay already provides. The existing approach uses fewer moving parts and no new infrastructure.

- **PostgreSQL already provides the durability layer.** The DB holds dispatch metadata, PIDs, statuses, `contract`, and `agent_phase_history`. Combined with the JSONL log, it covers the two recovery scenarios: reconnection of a surviving process (PID check + log tail), and terminal status for a dead process (interrupt + archive). Temporal's durable execution would sit on top of PostgreSQL anyway (either via Temporal's own DB or Temporal Cloud) without eliminating the existing DB.

- **Operational cost is disproportionate to the reliability gap.** Temporal requires a dedicated service (Temporal server or Temporal Cloud subscription), a separate worker process, and schema management for its own persistence tier. The architect dashboard is a single-developer local tool. The failure scenarios it currently handles — server restart while a dispatch is running, PID death, tmux session loss — are all covered by the existing PID polling and JSONL replay. The remaining gap (process death between the 2-second polling ticks) is an inherent OS-level race that Temporal does not eliminate.

## No-Go Rationale

Three concrete blockers make migration infeasible without a prior feature redesign:

1. **PTY/tmux re-attachment**: `pty.spawn('tmux', ['attach-session', ...])` in `restoreSessions` produces a live PTY handle tied to the current Node.js process. Temporal activities cannot hand off PTY handles across worker boundaries. Terminal sessions would need to be redesigned as external sidecar processes (not activities) to remain Temporal-managed.

2. **Streaming stdout during activity execution**: `wireDispatchHandlers` pipes `proc.stdout` directly to in-process WebSocket clients and JSONL files during execution — this is an event-driven streaming pattern, not a transactional operation. Temporal activities return a result; continuous streaming for hours requires the activity to hold its worker thread indefinitely, which defeats the purpose of Temporal's execution model and creates the same single-process dependency that currently exists.

3. **Local-only deployment constraint**: The tool runs entirely on a developer's macOS machine with no external service dependencies beyond Docker-hosted PostgreSQL. Adding a Temporal server or Temporal Cloud would break the self-contained deployment model and introduce internet-dependent execution paths for a local workflow tool.

## Consequences

**What stays the same:**

- JSONL log replay (`tailLogFile`) remains the session restore mechanism.
- PostgreSQL remains the sole persistence layer for dispatch metadata.
- PID polling and tmux re-attachment remain the liveness detection mechanisms.
- No new runtime dependencies or services are introduced.

**What this decision does not foreclose:**

- Targeted improvements to the current model — for example, replacing the 2-second polling interval with `inotifywait`/`fs.watch` on the JSONL file, or using `child_process.spawn` with `detached: true` and the PID written immediately to the DB — remain valid without requiring Temporal.
- If the architect dashboard is ever deployed as a multi-user, multi-node service, the feasibility question should be re-evaluated. In that scenario, the PTY and streaming constraints would still apply but the operational trade-off changes substantially.

## References

- `tools/dashboard/dispatch-manager.mjs` — `tailLogFile`, `restoreSessions`, `wireDispatchHandlers`
- `tools/dashboard/server.mjs` — `main()` startup phases, `shutdownFlush`, 60-second auto-cleanup loop
- `tools/dashboard/db.mjs` — `saveDispatch`, `getPersistedDispatches`, `markRunningAsInterrupted`, `updateTerminalStatus`
- W-964 — original recommendation to evaluate Temporal
- W-1011 — this investigation spike
