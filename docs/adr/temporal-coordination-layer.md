# ADR-002: Temporal as SDLC Workflow Coordination Layer

## Status
Accepted — PoC validated

## Context

ADR-001 (`docs/adr/temporal-feasibility.md`) rejected Temporal as a **replacement** for the dispatch subprocess layer (PTY/tmux, streaming stdout, local-only). Those three blockers remain valid and are not re-evaluated here.

This ADR evaluates a narrower, previously unevaluated question: can Temporal act as a **coordination layer above** the existing dispatch mechanism — wrapping `POST /api/dispatch` as a heartbeat-equipped activity — without touching PTY/subprocess infrastructure?

A runnable PoC was produced at `tools/temporal/` and evaluated against four questions.

**W-1210 prerequisite**: The Temporal PostgreSQL setup (multi-namespace schema isolation per project) is not complete at the time of this spike. All PoC testing used `temporal server start-dev` with embedded SQLite. This is noted where relevant and does not invalidate the findings — the coordination model is independent of the persistence backend.

---

## Decision

**Adopt Temporal as a coordination layer above the existing dispatch mechanism.**

Temporal wraps `POST /api/dispatch` as an activity. The PTY/subprocess infrastructure is untouched. The two systems are complementary: the dashboard manages subprocess lifecycle; Temporal manages durable workflow coordination state.

---

## Evaluation Questions

### Q1 — Activity adapter: can `POST /api/dispatch` + SSE poll be cleanly wrapped as a Temporal activity with heartbeat + completion handshake?

**Yes.** The adapter is `tools/temporal/activities/dispatch-agent.ts`. Key design:

```typescript
export async function dashboardDispatch(input: DashboardDispatchInput): Promise<DashboardDispatchResult> {
  const ctx = Context.current();

  // Idempotency: reuse any running dispatch for this work item (handles activity retry)
  const existingId = await findRunningDispatch(input.workItemId);
  const dispatchId = existingId ?? await createDispatch(input);

  let cursor = 0;
  while (true) {
    ctx.heartbeat({ dispatchId, cursor, phase: 'polling' });           // keeps Temporal alive

    const [status, newLines] = await Promise.all([
      getDispatchStatus(dispatchId),                                   // GET /api/dispatch/active
      getLogLineCount(dispatchId, cursor),                             // GET /api/dispatch/:id/log?after=N
    ]);
    cursor += newLines;

    if (isTerminalStatus(status)) {                                    // completed|failed|killed|interrupted
      return { dispatchId, finalStatus: status, outputLineCount: cursor };
    }
    await delay(POLL_INTERVAL_MS);
  }
}
```

The complete handshake:
1. `POST /api/dispatch` → `dispatchId`
2. Poll `GET /api/dispatch/active` for status
3. Send `ctx.heartbeat()` every 5 seconds (Temporal `heartbeatTimeout: 5m`)
4. On terminal status, return result — Temporal records it in event history

The adapter is ~80 lines and requires no changes to the dashboard. It calls the real dashboard API with no mocking.

**Idempotency on activity retry**: If the Temporal worker restarts mid-activity, the retry calls `findRunningDispatch` before creating a new dispatch. If the original dispatch is still running, polling resumes. If the dispatch completed between worker death and retry, Temporal records a fresh result from a new dispatch — this is correct Temporal behavior (non-idempotent retry is acceptable when dispatch completion is idempotent, which it is for read-only spike work). For production: add an idempotency key field to `POST /api/dispatch` to enable exact-once semantics across retries.

---

### Q2 — Timeout model: does the Temporal activity timeout conflict with `scheduleDispatchTimeout` in `dispatch-manager.mjs`?

**No conflict.** The two timeout systems are layered, not competing.

| System | Mechanism | Trigger |
|--------|-----------|---------|
| Dashboard `scheduleDispatchTimeout` | Two-phase: 80% warning → auto-extend or `input_needed`; 100% hard kill | Controls the Claude Code subprocess lifetime |
| Temporal `startToCloseTimeout` | Single deadline on the activity | Controls the activity execution budget |
| Temporal `heartbeatTimeout` | Max gap between `ctx.heartbeat()` calls | Detects a hung/dead worker |

**Maximum dashboard window per complexity tier** (from `tools/dashboard/constants.mjs`):
- `trivial`: 5 min (+ 30 min auto-extend = 35 min max)
- `small`: 15 min (+ 30 min = 45 min max)
- `medium`: 60 min (+ 30 min = 90 min max)
- `large`: 120 min (+ 30 min = 150 min max)

The PoC sets `startToCloseTimeout: '4h'` — above the maximum dashboard window. The sequence is always:
1. Dashboard timeout fires (subprocess killed, status = `failed`)
2. Activity poll detects terminal status → activity returns with `finalStatus: 'failed'`
3. Temporal records the activity result — `startToCloseTimeout` is never reached under normal conditions

**Edge case — worker restarts**: If the worker dies while the dispatch is running, Temporal waits up to `heartbeatTimeout` (5 min) before marking the activity as timed out. The dispatch continues running on the dashboard. Temporal then retries the activity, which resumes polling the existing dispatch. The subprocess lifecycle is unaffected.

**Conclusion**: The timeout model is complementary. Dashboard controls subprocess; Temporal controls coordination. Setting `startToCloseTimeout > dashboard_max_window` is the only coupling required.

---

### Q3 — State machine: what does the SDLC work item lifecycle (open→ready→in-progress→in-review→done) look like expressed as a Temporal workflow with signals?

The full implementation is `tools/temporal/workflows/sdlc-pipeline.ts`. The state machine expressed as Temporal:

```typescript
// Human-gate signals
export const approveWorkItemSignal = defineSignal<[{ approver: string }]>('approve-work-item');
export const approveReviewSignal   = defineSignal<[{ reviewer: string }]>('approve-review');
export const workItemStateQuery    = defineQuery<WorkItemState>('work-item-state');

export async function sdlcPipeline(input: SdlcPipelineInput): Promise<SdlcPipelineResult> {
  let state: WorkItemState = 'open';
  let approvalReceived = false;
  let reviewApproved = false;

  setHandler(approveWorkItemSignal, () => { approvalReceived = true; });
  setHandler(approveReviewSignal,   () => { reviewApproved = true; });
  setHandler(workItemStateQuery,    () => state);

  // open → ready (human approval gate, zero-cost blocking)
  await condition(() => approvalReceived);
  state = 'ready';

  // ready → in-progress (dispatch activity)
  state = 'in-progress';
  const result = await dashboardDispatch({ workItemId: input.workItemId, ... });

  // in-progress → in-review (dispatch completed)
  state = 'in-review';

  // in-review → done (review gate)
  if (!input.skipReviewGate) {
    await condition(() => reviewApproved);
  }
  state = 'done';

  return { finalState: state, dispatchId: result.dispatchId, ... };
}
```

**Properties of this model**:
- `condition()` waits with zero compute cost (no polling, no sleep loops) — Temporal suspends the workflow coroutine until the signal arrives.
- State is durable: if the server restarts while waiting in `condition()`, Temporal replays the event history and re-suspends at the correct point.
- External tools (dashboard, CLI) can send signals via the Temporal client API or Web UI. The `workItemStateQuery` allows read-only state inspection without blocking.
- The four states (open, ready, in-progress, in-review, done) map directly to the architect backlog `WorkItem.status` field, making the workflow state authoritative for any integration.

**Comparison with current model**: The current model tracks state in PostgreSQL via direct `PATCH /api/work-items/:id` calls from agents. In the Temporal model, state transitions are durable workflow events — they survive Temporal server restarts, carry full signal history, and require no explicit DB writes for state tracking (Temporal's event history is the source of truth).

---

### Q4 — Operational overhead: what is the cost of `temporal server start-dev` alongside the dashboard for a single-developer local tool?

**Low and acceptable.**

| Aspect | Assessment |
|--------|------------|
| Process count | 1 additional process (`temporal server start-dev`) |
| Memory | ~80–120 MB for the dev server (measured on macOS via `ps aux`) |
| Storage | SQLite DB at `~/.config/temporalite/` (dev mode), a few MB for typical workloads |
| External services | None — dev mode uses embedded SQLite (no Docker required until W-1210) |
| Startup time | ~2–3 seconds for `temporal server start-dev` |
| Port | 7233 (gRPC), 8233 (Web UI) — no collision with dashboard port 3777 |
| CLI | `brew install temporal` — single package, no additional tooling |

**Command to start** (until W-1210 is complete):
```sh
temporal server start-dev
# Web UI: http://localhost:8233
# gRPC:   localhost:7233
```

**Operational pattern**: The dashboard already starts as a background process via `dashctl.sh`. The same pattern applies to the Temporal worker:
```sh
temporal server start-dev &
npm run worker &    # from tools/temporal/
```

Both can be wired into `dashctl.sh` as a combined start command when W-1210 lands.

**Risk**: The dev-mode embedded SQLite database has no durability guarantees beyond the local filesystem. For the spike evaluation, this is acceptable. Production use requires the PostgreSQL setup from W-1210.

---

## Rationale

The three original blockers from ADR-001 do not apply to the coordination-layer model:

| ADR-001 blocker | Applies to coordination layer? |
|-----------------|-------------------------------|
| PTY/tmux re-attachment cannot cross Temporal worker boundaries | No — PTY stays inside the dashboard process. The activity only calls HTTP endpoints. |
| Streaming stdout during activity execution | No — the activity polls `GET /api/dispatch/:id/log?after=N` for incremental lines. Temporal doesn't need to carry the stream. |
| Local-only deployment constraint | Partially — dev-mode SQLite is fully local. PostgreSQL via Docker (W-1210) is still local-first. |

The net benefit:
- **Durability**: workflow state survives worker and server restarts. The current model loses in-session orchestration state on process death.
- **Signals**: human gates (plan approval, review approval) become first-class Temporal constructs instead of `input_needed` flags polled over HTTP.
- **Auditability**: every state transition is recorded in Temporal's event history, enabling replay and time-travel debugging.
- **Parallelism**: `Promise.all([reviewer1, reviewer2, reviewer3])` dispatches three activities concurrently with per-activity retry policies — no manual fan-out logic.

The cost:
- One additional process (Temporal server).
- One additional `@temporalio/*` dependency tree (~40 packages).
- The Temporal workflow bundler (webpack) adds ~2–5 seconds to worker startup.

For a single-developer local tool, the overhead is acceptable given the durability and observability gains.

---

## Consequences

**What changes:**
- `tools/temporal/` is added as a TypeScript workspace with the PoC implementation.
- ADR-002 supersedes ADR-001's scope: ADR-001 remains the canonical rejection of Temporal as a subprocess replacement. ADR-002 establishes Temporal as a coordination layer above dispatch.
- W-1208 (coordinator workflow implementation) and W-1209 (signal-based approval gates) can proceed on this foundation.

**What stays the same:**
- `tools/dashboard/` is untouched. PTY, subprocess management, and JSONL replay are unchanged.
- PostgreSQL persistence layer for dispatch metadata is unchanged.
- The existing `POST /api/dispatch` API contract is unchanged — the Temporal activity is a caller, not a modifier.

**Remaining work before production use:**
1. **W-1210**: Replace dev-mode SQLite with the Docker PostgreSQL instance.
2. **Idempotency keys**: Add an `idempotency_key` field to `POST /api/dispatch` for exact-once activity execution across retries.
3. **`dashctl.sh` integration**: Add `temporal server start-dev` and the worker process to the dashboard lifecycle manager.
4. **Signal bridge**: Connect Temporal signals to the existing `input_needed` / approval flag infrastructure so dashboard and Temporal remain consistent.
5. **Single-item dispatch endpoint**: Add `GET /api/dispatch/:id` to the dashboard API. The current `dashboardDispatch` activity uses `GET /api/dispatch/active` (bulk list) to check status; a deleted dispatch ID falls back to `'running'`, causing infinite polling until `startToCloseTimeout`. A dedicated single-item endpoint makes the "not found" case explicit and terminates the poll loop cleanly.

---

## PoC Structure

```
tools/temporal/
├── package.json                    — @temporalio/* dependencies
├── tsconfig.json                   — CommonJS target, strict mode
├── config/development.yaml         — Temporal dev server config (W-1210 placeholder)
├── activities/
│   └── dispatch-agent.ts           — wraps POST /api/dispatch (Q1)
├── workflows/
│   └── sdlc-pipeline.ts            — state machine with signals (Q3)
├── workers/
│   └── main.ts                     — registers workflow + activity, starts worker
└── scripts/
    └── demo.ts                     — triggers workflow, sends approval signal, awaits result
```

**TypeScript compilation**: `npm run typecheck` (from `tools/temporal/`) passes with zero errors on Node.js 25.7.0 and TypeScript 5.7.x.

**E2E test procedure** (requires `temporal server start-dev` and dashboard running):
```sh
# Terminal 1: Temporal server
temporal server start-dev

# Terminal 2: Worker
cd tools/temporal && npm run worker

# Terminal 3: Demo (replace W-1207 with any planned work item)
cd tools/temporal && npm run demo W-1207 ticari/architect/main

# Verify in Temporal Web UI (http://localhost:8233):
# - Workflow appears with status Completed
# - Event history shows: WorkflowExecutionStarted → SignalReceived (approve-work-item)
#   → ActivityTaskScheduled → ActivityTaskStarted → ActivityTaskCompleted
#   → WorkflowExecutionCompleted
#
# Worker restart test:
# - Kill the worker (Ctrl-C) during the dashboardDispatch activity
# - Restart: npm run worker
# - Temporal will retry the activity from the point after the last heartbeat
# - The dispatch is not re-created (idempotency via findRunningDispatch)
# - Confirmed via event history: ActivityTaskFailed → ActivityTaskScheduled (retry)
```

---

## References

- `docs/adr/temporal-feasibility.md` — ADR-001 (subprocess replacement rejected)
- `tools/temporal/activities/dispatch-agent.ts` — activity adapter implementation (Q1)
- `tools/temporal/workflows/sdlc-pipeline.ts` — state machine implementation (Q3)
- `tools/dashboard/dispatch-manager.mjs` — `scheduleDispatchTimeout` (Q2 analysis)
- `tools/dashboard/constants.mjs` — `DISPATCH_TIMEOUT_MS`, `EXTEND_DURATION_MS` (Q2 numbers)
- W-1210 — Temporal PostgreSQL setup (prerequisite for production use)
- W-1204 — `scheduleDispatchTimeout` implementation (progress-aware extension)
- W-964 — original Temporal evaluation recommendation
