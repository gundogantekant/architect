# Multi-User Session Orchestrator

**Work item**: W-1209  
**Status**: MVP implemented  
**Audience**: Engineers building on or extending the Temporal gateway layer

---

## Overview

Each user conversation runs through a durable `UserSessionWorkflow` — one Temporal workflow per active session, keyed by `sessionId` as the workflowId. Sessions receive user messages via Temporal signals, run intent classification and context retrieval, perform parallel multi-domain analysis, optionally gate on human approval, and call `continueAsNew` to survive long conversations without hitting Temporal's event history limit.

---

## Component Diagram

```
User / Dashboard
       │
       │ userMessageSignal (content, messageId)
       │ approvalSignal    (approver, approved)
       ▼
┌─────────────────────────────────────────────────────────┐
│  UserSessionWorkflow  (namespace: architect)            │
│  workflowId = "user-session-{sessionId}"               │
│                                                         │
│  1. classifyIntent ─────────────────────────────────►  │ ◄── Claude API (haiku)
│  2. ragRetrieval ────────────────────────────────────►  │ ◄── portfolio JSON + backlog HTTP
│                                                         │
│  3. analyzeCloudImpact   ─────────────────────────►    │ ◄── Claude API (haiku)  ┐ parallel
│     analyzeFrontendImpact ─────────────────────────►   │ ◄── Claude API (haiku)  ┘
│                                                         │
│  4. [approval gate if intent=implement/deploy]         │
│     await condition(approvalSignal)                    │
│     dashboardDispatch ──────────────────────────────►  │ ◄── POST /api/dispatch
│                                                         │
│  5. continueAsNew (at historyLength >= threshold)      │
└─────────────────────────────────────────────────────────┘
       │
       │ sessionStateQuery → SessionSnapshot
       ▼
  Caller / Test Script
```

---

## Architect → Temporal Concept Mapping

| Architect Pattern | Temporal Equivalent | Notes |
|---|---|---|
| Sub-agent dispatch (single) | **Activity** — runs once, returns result, can heartbeat | `dashboardDispatch` wraps `POST /api/dispatch` |
| Parallel fan-out (multiple independent) | `Promise.all([activity1, activity2])` in workflow | Cloud + frontend analysis |
| Sequential pipeline (A→B→C) | `await activityA(); await activityB();` | classify → RAG → parallel analysis |
| Skill (/implement, /review, /test) | **Workflow type** — each skill is a workflow definition | `sdlcPipeline`, `userSessionWorkflow` |
| Agent (coder-backend, tester, reviewer) | **Activity calling Claude Code** via `dispatchAgentActivity` | `dashboardDispatch` activity |
| Isolated analysis (cloud or frontend impact) | **Activity calling Claude API directly** — no subprocess | `analyzeCloudImpact`, `analyzeFrontendImpact` |
| Isolated execution (implement cloud changes) | **Child Workflow** calling `dispatchAgentActivity` | `cloudEvalWorkflow`, `frontendEvalWorkflow` (stubs) |
| Human-in-the-loop approval | `workflow.condition()` waiting for `approvalSignal` | Approval gate in `UserSessionWorkflow` |
| Review board (parallel agents) | `Promise.all([childWorkflow1, childWorkflow2])` | Future: parallel review board as child workflows |
| Work item state machine | Workflow state + Signals | `sessionState` + `userMessageSignal` + `approvalSignal` |
| Coordinator routing decision | `switch(intent.intentType)` dispatching to activity or child workflow | Intent → approval gate routing |

---

## Activity vs Child Workflow — the Decision Rule

The distinction determines which execution model is used for a given task:

| Criterion | Use Activity | Use Child Workflow |
|---|---|---|
| **Task type** | Analysis — read, assess, classify, plan | Execution — edit files, run tests, apply changes |
| **I/O model** | Direct Claude API call, structured JSON result | Full Claude Code session (`claude -p`), subprocess |
| **Latency** | Fast (seconds) | Slow (minutes to hours) |
| **State needed** | None — stateless function | Full agent context: tools, MCP, skill loading |
| **Retry semantics** | Activity retry policy (Temporal) | Workflow-level (restart from last activity) |
| **Examples** | `classifyIntent`, `analyzeCloudImpact`, `analyzeFrontendImpact`, `ragRetrieval` | `cloudEvalWorkflow`, `frontendEvalWorkflow`, `sdlcPipeline` |

**Rule**: _analysis_ → activity. _execution_ → child workflow.

The multi-domain parallel evaluation in this MVP (`analyzeCloudImpact` + `analyzeFrontendImpact`) is **analysis** — both call Claude API directly inside activities, run in parallel via `Promise.all`, and return structured JSON. No subprocess overhead, no file editing.

When a future requirement needs to **apply** cloud changes (e.g., run Terraform, commit infra files), route through `cloudEvalWorkflow` instead — it spawns a full Claude Code session.

---

## Folder Structure

```
tools/temporal/
  signals.ts             ← Shared signal definitions (userMessageSignal, approvalSignal)
  queries.ts             ← Shared query definitions (sessionStateQuery)
  workflows/
    user-session.ts      ← UserSessionWorkflow — one per active session
    sdlc-pipeline.ts     ← Full SDLC workflow (implement, review, test, deploy)
    cloud-eval.ts        ← Child workflow stub: cloud execution (future)
    frontend-eval.ts     ← Child workflow stub: frontend execution (future)
  activities/
    classify-intent.ts   ← Claude API: parse user message → SdlcIntent
    rag-retrieval.ts     ← Portfolio JSON + dashboard backlog + session history → RagContext
    dispatch-agent.ts    ← Wrap POST /api/dispatch, poll for completion
    analyze-cloud.ts     ← Claude API: cloud infrastructure impact analysis
    analyze-frontend.ts  ← Claude API: frontend/UI impact analysis
  workers/
    main.ts              ← sdlcPipeline worker (namespace: default, queue: sdlc-pipeline)
    session-worker.ts    ← UserSessionWorkflow worker (namespace: architect, queue: user-session)
  scripts/
    demo.ts              ← Interactive demo for sdlcPipeline
    test-e2e.ts          ← Integration test for all 4 E2E criteria
  config/
    development.yaml     ← Temporal server config (Postgres persistence)
    .env.example         ← All required env vars with documentation
  fixtures/
    backlog.json         ← Fallback backlog when dashboard is offline
```

### Two-Worker Topology

| Worker | Namespace | Task Queue | Workflows | Key Activities |
|---|---|---|---|---|
| `main.ts` | `default` | `sdlc-pipeline` | `sdlcPipeline` | `dashboardDispatch` |
| `session-worker.ts` | `architect` | `user-session` | `userSessionWorkflow` | `classifyIntent`, `ragRetrieval`, `analyzeCloudImpact`, `analyzeFrontendImpact`, `dashboardDispatch` |

Activities must be registered in the same worker as the workflows that call them. `dashboardDispatch` is registered in both workers because both `sdlcPipeline` and `userSessionWorkflow` use it.

---

## RAG Pattern

`ragRetrievalActivity` combines three context sources into a single `RagContext`:

| Source | Location | Fallback |
|---|---|---|
| Portfolio entries | `$ARCHITECT_PORTFOLIO_DIR/**/*.json` | Empty array if dir missing |
| Live backlog | `GET $DASHBOARD_URL/api/backlog` | `fixtures/backlog.json` |
| Session history | In-workflow state (last 10 synthesis strings) | Empty array on first message |

Both portfolio and backlog are fetched in parallel (`Promise.all`) to minimize latency. The fixture fallback is automatic — no configuration needed. To develop offline, ensure `ARCHITECT_PORTFOLIO_DIR` points to a local directory and let RAG fall back to the fixture.

`RagContext` is passed to both `analyzeCloudImpact` and `analyzeFrontendImpact`, which filter the backlog items by `project_key` before including them in the prompt.

---

## Session Lifecycle and `continueAsNew`

Temporal's event history hard limit is 51,200 events. A long user session can hit this limit if left unchecked. The solution is `continueAsNew`: after each message cycle, the workflow checks `workflowInfo().historyLength` against a configurable threshold (default 1000). When the threshold is reached and the message queue is drained, the workflow calls `continueAsNew`, which starts a fresh execution with the same workflowId but a new runId.

**State forwarded across `continueAsNew`**:
- `recentMessages: ProcessedMessage[]` — last 100 processed messages (trimmed to stay < 2 MB)
- `totalMessageCount: number` — global message counter across all runs
- `lastMessageId: string` — for deduplication

**Deduplication**: `processedIds` is rebuilt from `recentMessages` on startup. If a signal arrives that was already processed in the previous run, it is silently skipped.

**Payload budget**: 100 messages × ~2 KB avg = ~200 KB, well under Temporal's ~2 MB input limit.

---

## Gotchas

### Workflow determinism
Workflow code (`workflows/`) must be purely deterministic. Never call:
- `Date.now()` — use `workflow.now()` if timestamps are needed
- `Math.random()` — use `workflow.random()` for deterministic random values  
- Any Node built-ins that touch I/O (`fs`, `http`, `child_process`)

All I/O lives in activity files (`activities/`). Temporal replays workflow code on restart — non-deterministic code produces different results during replay, causing `NonDeterminismError`.

### Import type discipline
In workflow files, always use `import type` for activity modules:
```typescript
import type { ClassifyIntentInput, SdlcIntent } from '../activities/classify-intent';
```
Value imports pull activity module code (including `Anthropic`, `fs`, `fetch`) into the workflow bundle. TypeScript erases `import type` at compile time; it never reaches the workflow V8 isolate.

`signals.ts` and `queries.ts` are safe to import as values in workflow code because they only import from `@temporalio/workflow`.

### Namespace isolation
`main.ts` uses namespace `default` (sdlcPipeline, pre-existing). `session-worker.ts` uses namespace `architect` (UserSessionWorkflow, registered by W-1210). Sending a signal to the wrong namespace fails silently — the workflow never receives it. Always confirm namespace when debugging signal delivery.

### Activity registration scope
Activities must be registered in the worker that runs workflows calling them. If `analyzeCloudImpact` is registered only in `session-worker.ts` (namespace `architect`), it cannot be called from `sdlcPipeline` (namespace `default`). The two-worker topology table above is the authoritative reference.

### `workflowExecutionTimeout`
This is a client-side option set at `client.workflow.start()` time — it cannot be set inside the workflow function. The session worker (`session-worker.ts`) does not set it by default; callers (test scripts, dashboard, CLI) must pass it explicitly: `workflowExecutionTimeout: '2h'`.

### `continueAsNew` and in-flight signals
Signals in the message queue at the time of `continueAsNew` are lost. The implementation avoids this by only calling `continueAsNew` when `messageQueue.length === 0`. However, signals arriving in the narrow window between the queue check and the `continueAsNew` call can still be lost.

**Mitigation**: If signal delivery is critical, callers should re-send the signal if they do not observe the expected state transition within a reasonable timeout. The deduplication system (`processedIds`) prevents double-processing of re-sent signals that were already handled — only genuinely lost signals need re-sending.

**Deduplication scope**: `processedIds` is built from the last `MAX_RETAINED_MESSAGES=100` processed messages passed through `continueAsNew`. Messages older than 100 cycles are not deduplicated across run boundaries; a re-sent message with a recycled messageId could be processed twice if its ID has aged out of the window. Use a globally unique messageId (e.g., timestamp + sessionId) to avoid this.

### Cross-namespace child workflow composition
`cloudEvalWorkflow` and `frontendEvalWorkflow` stubs inherit their activity task queue from the calling workflow's context. They must only be started from within the `architect` namespace on task queue `user-session`. Calling them as child workflows from `sdlcPipeline` (namespace `default`, queue `sdlc-pipeline`) would cause the `dashboardDispatch` activity inside the child to wait on the wrong task queue and time out silently — a subtle failure with no clear error message. Always pass `{ taskQueue: 'user-session' }` in `startChildWorkflow` options when calling these stubs.

### Anthropic SDK model IDs
Activities use `claude-haiku-4-5-20251001` by default (fast, cheap, suited for classification and analysis). Override via `ANTHROPIC_CLASSIFY_MODEL` and `ANTHROPIC_ANALYSIS_MODEL` env vars. Verify model IDs at https://docs.anthropic.com/en/docs/about-claude/models if the default becomes deprecated.

---

## References

- `docs/guides/temporal-for-agents.md` — Temporal mental model, dispatch pattern, concurrency guide
- `docs/research/workflow-orchestration-frameworks.md` — Framework evaluation, Temporal adoption rationale
- `tools/temporal/config/.env.example` — All required environment variables
- W-1207 — `dashboardDispatch` activity (POST /api/dispatch wrapper)
- W-1210 — PostgreSQL persistence setup and `architect` namespace registration
- Temporal TypeScript SDK: https://docs.temporal.io/develop/typescript
- `continueAsNew` pattern: https://docs.temporal.io/workflows#continue-as-new
