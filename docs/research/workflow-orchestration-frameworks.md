# Workflow Orchestration Frameworks: Research and Recommendation (Revised)

**Work item:** W-964
**Date:** 2026-05-01
**Status:** Final — supersedes prior version
**Decision required:** Choose a workflow orchestration framework for a **greenfield** agentic SDLC system that runs **multi-day autonomous sessions**.

---

## 1. Executive Summary

**Adopt Temporal.io. Hold Conductor OSS as the primary alternative if declarative JSON workflows or native polyglot workers are central product requirements.**

The recommendation in the prior version of this document (LangGraph) was correct under different constraints — incremental adapter integration into the existing architect Node.js dashboard at the current 6–16 step scale. Two clarified constraints flip the answer:

1. **Greenfield project, no migration concern.** Refinement classification ("minor adapter" vs "major rewrite") drops to zero weight. Whichever framework wins on capability wins outright.
2. **Multi-day autonomous SDLC sessions** including 12+ hour real-time hardware tests, multi-day human-in-the-loop waits, and iterative test-adjustment loops. Long-running task autonomy moves from "high weight" to **the dominant criterion**.

Under these constraints, Temporal.io's event-sourced replay is the strongest durability primitive available, its TypeScript SDK is production-grade, and its conceptual model — workflow as deterministic code, side effects in retriable activities — is purpose-built for exactly this workload (it is what Stripe, Coinbase, and Snap use for multi-day stateful workflows). Conductor OSS is a serious second option whose declarative JSON DAG and native polyglot worker model give it a clear identity for systems where workflows are dynamically composed or workers span multiple languages. LangGraph, Inngest, and Prefect are all eliminated for hard reasons described in §3.

---

## 2. Updated Constraints and Re-Weighted Criteria

### Constraints (revised)

| Constraint | Implication |
|---|---|
| Greenfield project | Refinement classification has near-zero weight |
| Self-hosted OSS only, no fees | Cloud pricing irrelevant; license matters only for distribution |
| 12+ hour real-time hardware tests | Step-level duration ceilings are gating; checkpoint-resume bugs are critical |
| Multi-day human-in-the-loop waits | Indefinite-suspension primitive is gating; timeout-required APIs are awkward |
| Iterative test-adjustment loops | Loop semantics within workflows must be first-class |
| TypeScript preferred, but flexible | Polyglot is a legitimate option |

### Criteria weights (revised)

| Criterion | Original weight | Revised weight |
|---|---|---|
| Long-running task autonomy | High | **Critical** |
| Durable sequential step enforcement | High | **Critical** |
| Automatic retry with configurable backoff | High | High |
| Contractual terms enforcement | High | High |
| Operational complexity | Medium | Medium |
| TypeScript/Node.js SDK | Gate | Gate |
| Self-hosting | Gate | Gate |
| Refinement needs | Medium | **Near zero** |

---

## 3. Eliminated Frameworks

### Prefect — eliminated
No Node.js SDK and the failure mode is wrong for long workloads. Even in a Python greenfield, Prefect's heartbeat-driven CRASHED-on-restart behavior would falsely fail 12-hour test sessions when the server bounces. Disqualifying.

### LangGraph (JS) — eliminated for this workload
The original recommendation. Three issues become disqualifying for multi-day autonomous sessions:
- **Bug #1308**: JS resume-from-checkpoint can replay from step 0. For a 12-hour hardware test, this is a workday lost. Not acceptable for the new use case.
- **Recursion limit (default 25)**: configurable, but no platform support for true unbounded loops — `continueAsNew` has no equivalent.
- **No per-node timeout primitive**: hung activities require manual `Promise.race` wrappers; for activities that legitimately run 12 hours, the missing primitive forces brittle hand-rolled timeout management.

LangGraph remains the right choice for in-process state graphs at the hour scale. It is the wrong choice when sessions are measured in days and a single resume failure costs a workday.

### Inngest — eliminated for this workload
- **2-hour per-step cap** is the dominant issue. The platform documents a 2-hour ceiling per individual `step.run()` (hosting-provider dependent on Inngest Cloud; configurable on self-host but with operational implications). For 12-hour hardware tests, the test must be split across multiple steps with state passed between them — possible but adds bookkeeping that other frameworks don't require.
- **`step.waitForEvent()` requires a timeout**, returning `null` on expiry. For "human will reply when they reply" gates, this forces the application to model timeout-and-rearm logic that has no business reason.
- **Step-in-loop anti-pattern**: iterative test-adjustment loops must be refactored into event-driven fan-out, which doesn't fit the test-and-adjust shape naturally.

Inngest's `step.invoke()` composition primitive is excellent for short-to-medium workflows. For multi-day autonomous sessions, the structural ceilings cost more than the primitive earns.

---

## 4. Why Temporal.io is the Recommendation

### 4.1 Long-running task autonomy: gold-standard durability

Workflow state is reconstructed by replaying an immutable event history. Every state-changing event (activity scheduled, completed, signal received, timer fired) is persisted before any worker code runs. When a server, worker, or developer laptop restarts, the workflow resumes at the exact unfinished activity — not from the start, not from the last checkpoint. This is the *defining* property of the platform, not an add-on, which is why it is the framework of choice for systems where losing state is unacceptable (Stripe payment workflows, Coinbase trading, Datadog telemetry pipelines).

Three concrete primitives matter for the architect-style workload:

- **`workflow.condition(predicate, timeout?)`** suspends a workflow with **zero compute cost** until a signal mutates state. For a multi-day human-in-the-loop wait, the workflow consumes nothing while idle — no worker process, no polling, no resource pressure. The optional timeout uses Temporal's durable timer system; it survives server restarts.
- **`continueAsNew`** atomically completes the current run and starts a new run with the same Workflow ID, passing state as input. This resets the per-workflow event history limit (51,200 events / 50 MB), enabling truly unbounded runs. Iterative test-adjustment loops use this at the loop boundary: every N iterations, `continueAsNew` flushes history and starts fresh.
- **Activity heartbeats** (`activity.heartbeat()`) detect hung work without arbitrary timeouts. A 12-hour hardware test is configured with a `heartbeatTimeout` of, say, 5 minutes; the activity periodically heartbeats while running; if it stops heartbeating, the platform marks the activity for retry and the workflow can decide what to do. This is the right shape for "long activity that should not silently hang."

### 4.2 Iterative test-adjustment loops: natural code

Temporal workflows are TypeScript code. An iterative loop reads as straight-line:

```typescript
while (!verdict.passed) {
  await adjustTests(currentInputs);
  verdict = await runHardwareTests(currentInputs);
  if (verdict.iterations > maxIterations) break;
  if (workflowInfo().continueAsNewSuggested) {
    return continueAsNew<typeof loopWorkflow>({ verdict, currentInputs });
  }
}
```

No DAG primitive to learn, no fan-out refactor, no anti-pattern around step-in-loop. The platform handles persistence; the code expresses intent.

### 4.3 TypeScript SDK quality

`@temporalio/*` v1.17.0 is stable, production-grade, supported on Node 20/22/24, and has been used in production at companies that depend on it for revenue-critical workflows. The conceptual constraints (workflow code must be deterministic; no Node built-ins inside workflow functions) are real but well-documented and enforced by the SDK at runtime. Activities are normal async TypeScript with no constraints. The only ramp cost is internalizing the workflow/activity boundary — a 1-to-2 week investment for an experienced TypeScript developer.

### 4.4 Operational footprint

- **Local development**: `temporal server start-dev` is one Go binary with embedded SQLite, starts in under two seconds. Web UI on `localhost:8233`. Zero external dependencies.
- **Production self-hosted**: Temporal server binary + PostgreSQL + optional Elasticsearch (only needed for advanced visibility queries). Docker Compose templates provided. MIT license, no usage limits, no telemetry, no cloud requirement.

This is genuinely lighter than Conductor's JVM + Postgres baseline.

### 4.5 Failure handling

Per-activity retry is fully configurable: `initialInterval`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts` (0 = unlimited), `nonRetryableErrorTypes` for fast-fail classes. Workflows themselves do not retry by default; that is opt-in. The `Saga` pattern in TypeScript is manual (compensation registration in code, unlike Java's built-in `Saga` class), which is a small cost relative to the platform's other strengths.

---

## 5. Why Conductor OSS is the Primary Alternative

Conductor is not a fallback — it is a legitimate alternative whose strengths are *different* from Temporal's. Choose Conductor over Temporal if any of the following are core product requirements:

### 5.1 Workflows as data, not code

Conductor workflows are JSON DAG documents. The shape of a workflow can be inspected, edited, generated, or composed at runtime by an agent — the workflow definition is a first-class data artifact. For an SDLC agent system where higher-level agents might *generate* workflows for lower-level agents to execute, this is genuinely valuable in a way Temporal's "workflow is TypeScript code" model is not.

### 5.2 Declarative contract enforcement

Conductor is the only finalist with **native JSON Schema (draft 2020-12) validation** on task inputs and outputs. A task's `expected_output` becomes a runtime guarantee enforced by the platform: if a worker's output fails the schema, the task transitions to `FAILED_WITH_TERMINAL_ERROR` without any verifier code being written. This is the cleanest mapping in the field for the structural part of a `DispatchContract`.

### 5.3 Native polyglot workers

Conductor workers are stateless processes that poll task queues over HTTP. A single Conductor server can simultaneously serve workers in TypeScript, Python, Go, Java, and any other language with an HTTP client. For an SDLC agent system that calls Python ML tools, Go binaries, and TypeScript orchestration code in the same workflow, polyglot is *idiomatic*, not awkward. Temporal supports multiple language SDKs but mixing within a single workflow is harder.

### 5.4 First-class HUMAN task

Conductor's `HUMAN` task type is purpose-built for human-in-the-loop gates. It transitions to `IN_PROGRESS` immediately and stays there until externally resolved via API. No timeout requirement. No bookkeeping. The waiting state is fully durable — server restarts have no effect. Documentation is explicit: "Whether the reviewer responds in 5 seconds or 5 days, the workflow state is preserved."

### 5.5 Built-in compensation via `failureWorkflow`

Each workflow definition can name a `failureWorkflow` that is automatically triggered if the main workflow fails. The compensation workflow receives the failed workflow's ID and task data as input. This is more declarative than Temporal's manual saga pattern in the TypeScript SDK.

### 5.6 Where Conductor loses to Temporal

- **JS SDK maturity**: `@io-orkes/conductor-javascript` v3.0.3 has 52 GitHub stars and lags the Java SDK substantially. Open HTTP/2 bug. Functional but visibly less invested in. Temporal's TypeScript SDK is in a different league.
- **Operational footprint**: JVM Conductor server + Postgres + Docker is heavier than Temporal's Go binary + Postgres. The ARM64 Elasticsearch issue on macOS is a known papercut (workaround: use Postgres-only mode without Elasticsearch).
- **Idempotency discipline**: Conductor delivers tasks with at-least-once semantics. Workers must be written to detect re-delivery and no-op. Temporal's deterministic replay handles this transparently.
- **Workflow expressiveness**: complex business logic in JSON DAGs is more painful than the same logic in TypeScript. Temporal's code-as-workflow scales better as orchestration logic grows.

---

## 6. Head-to-Head: Temporal vs Conductor OSS

This is the operational comparison most relevant to the decision.

### 6.1 Capability matrix

| Dimension | Temporal | Conductor OSS |
|---|---|---|
| **Workflow representation** | Deterministic TypeScript code | Declarative JSON DAG |
| **Durability mechanism** | Event-sourced replay | State machine + Postgres persistence |
| **Indefinite human wait** | `workflow.condition()` + signal | `HUMAN` task |
| **12+ hour activity** | Long activity + `heartbeatTimeout` + `activity.heartbeat()` | Long Simple task + `responseTimeoutSeconds` + IN_PROGRESS keepalive |
| **Iterative loop** | `while` loop in TS + `continueAsNew` at boundary | `DO_WHILE` task primitive |
| **Unbounded run** | `continueAsNew` (resets event history) | No event history limit; long runs natively supported |
| **Sub-workflow** | Child workflow API | `SUB_WORKFLOW` task |
| **Parallel fan-out** | `Promise.all` over activity calls | `FORK_JOIN` task |
| **Conditional branch** | `if/else` in TS | `SWITCH` task |
| **Retry config** | Per-activity policy (full set: initial, coefficient, max interval, max attempts, non-retryable types) | Per-task definition (FIXED / EXPONENTIAL_BACKOFF / LINEAR_BACKOFF; max 10 retries) |
| **Compensation** | Manual saga in TS code | Native `failureWorkflow` |
| **Contract enforcement** | Verification activities + typed exceptions | Native JSON Schema on inputs/outputs |
| **Crash recovery** | Deterministic replay; transparent to app | Server reads persisted state; resumes exactly |
| **Worker idempotency** | Not required (replay is deterministic) | Required (at-least-once delivery) |
| **TypeScript SDK** | First-class, production-grade, v1.17.0 | Functional but lagging Java SDK; v3.0.3 |
| **Polyglot workers** | Multiple SDKs, mixing within workflow is awkward | Native; workers in any language hit same task queues |
| **Ops footprint (dev)** | Single Go binary + SQLite | Single Java binary + in-memory or Postgres |
| **Ops footprint (prod)** | Temporal server + Postgres | JVM Conductor server + Postgres |
| **macOS ARM64** | Native | Postgres-only mode required (Elasticsearch 6.8.x ARM64 unavailable) |
| **Web UI** | Workflow event history view, search | DAG visualization, run inspection |
| **License** | MIT | Apache 2.0 |
| **Production references** | Stripe, Coinbase, Datadog, Snap, Box, HashiCorp | Netflix (originally), JPMorgan, Tesla, GE Aviation, Cisco |
| **Conceptual learning curve** | Workflow determinism + replay semantics | JSON DAG syntax + idempotency + worker patterns |

### 6.2 Where each wins decisively

**Temporal wins on:**
- TypeScript SDK quality. Decisive — for a TypeScript-leaning project this alone is enough to choose Temporal.
- Long-running activity reliability. Event-sourced replay is the strongest durability guarantee in the field; for 12-hour hardware tests where state loss equals a lost workday, this is the right primitive.
- Loop expressiveness. Iterative test-adjustment loops fit naturally as `while` loops with `continueAsNew` at boundaries.
- Operational footprint. Go binary + Postgres is meaningfully lighter than JVM + Postgres + Docker.
- Worker simplicity. Activities don't need to handle re-delivery; replay is deterministic.

**Conductor wins on:**
- Workflow-as-data. JSON DAGs are inspectable, generatable, composable by agents at runtime.
- Declarative contract enforcement. JSON Schema on task outputs is the only native primitive for this in the field.
- Native polyglot. Workers in any language hit the same task queue without architectural gymnastics.
- HUMAN task as a first-class primitive. Cleaner than Temporal's `condition()` + signal pattern for pure approval gates.
- Built-in compensation. `failureWorkflow` is declarative; Temporal's TypeScript saga is manual.

### 6.3 Decision rule

Choose **Temporal** if:
- TypeScript is the primary language (decisive — JS SDK quality gap is too large to ignore).
- Workflows are mostly authored by humans, not generated by agents.
- Long-running activities (12+ hour tests) are common and durability is non-negotiable.
- Iterative loops are a first-class workflow shape.
- You want the lightest production ops footprint.

Choose **Conductor** if:
- Polyglot workers (Python ML + Go binaries + TS) are a core requirement.
- Higher-order agents will *generate* workflow definitions for lower-order agents to execute.
- Declarative JSON Schema contracts on every task output are a primary product feature.
- Human-readable DAG visualizations are a primary product feature (e.g., users inspect or edit workflows).
- The team is willing to absorb the lagging JS SDK as a known risk and patch as needed.

For the stated workload — agentic SDLC orchestration with multi-day autonomous sessions, 12+ hour hardware tests, iterative test-adjustment loops, multi-day human gates — **Temporal is the recommendation**. The decision rule above identifies the conditions under which Conductor would be preferred; none of them are compelling enough for the current scope.

---

## 7. Greenfield Architecture Sketch (Temporal)

This section describes the shape of a new project built on Temporal.

### 7.1 Component layout

```
project/
  workflows/              # Deterministic TypeScript workflow definitions
    sdlc-pipeline.ts      # End-to-end SDLC workflow per work item
    iterative-test.ts     # Test-and-adjust loop with continueAsNew
    review-board.ts       # Multi-agent parallel review with aggregation
  activities/             # Side-effecting work
    agent-dispatch.ts     # Spawn `claude -p` and stream output
    hardware-test.ts      # Run 12-hour hardware test with heartbeats
    git-ops.ts            # Commit, push, merge — all the impure git work
    notify.ts             # External notifications (Slack, Telegram, etc.)
  workers/
    main.ts               # Worker registers workflows + activities, polls task queue
  app/                    # Application layer (separate from workflow runtime)
    server.ts             # Web/API server — accepts user input, displays state
    dashboard/            # UI for workflow inspection, human gates
  infra/
    docker-compose.yml    # Temporal server + Postgres for production
    dev.sh                # `temporal server start-dev` wrapper
```

### 7.2 Layer boundaries (Clean Architecture)

| Layer | Contents |
|---|---|
| Domain | Work item, contract, agent role, project entity types |
| Use cases | Workflow definitions (`workflows/`) — describe orchestration intent |
| Adapters | Activities (`activities/`) — wrap external systems (Claude CLI, git, hardware bench, notifications) |
| Infrastructure | Workers (`workers/`), Temporal server config, Postgres schema |

Workflow definitions import domain types directly. Activities are the only place I/O happens. Workers are the runtime that connects everything.

### 7.3 Pattern catalogue

**Long-running activity with heartbeats** (12-hour hardware test):
```typescript
// activities/hardware-test.ts
export async function runHardwareTest(input: TestInput): Promise<TestResult> {
  const ctx = activityContext();
  for (const step of input.steps) {
    await runStep(step);
    ctx.heartbeat({ completedSteps: step.index });
  }
  return result;
}

// In workflow
const { runHardwareTest } = proxyActivities<typeof activities>({
  startToCloseTimeout: '24 hours',
  heartbeatTimeout: '5 minutes',
  retry: { maximumAttempts: 2 },
});
```

**Multi-day human gate**:
```typescript
const verdictSignal = defineSignal<[Verdict]>('verdict');
let verdict: Verdict | undefined;
setHandler(verdictSignal, (v) => { verdict = v; });

// Suspend indefinitely until verdict signal arrives
await condition(() => verdict !== undefined);

if (verdict.outcome === 'reject') {
  return await handleRejection(verdict);
}
```

**Iterative test-adjustment loop with unbounded runs**:
```typescript
let iteration = 0;
while (!result.passed && iteration < input.maxIterations) {
  await adjustTests(currentInputs);
  result = await runHardwareTest(currentInputs);
  iteration++;
  if (workflowInfo().continueAsNewSuggested) {
    return continueAsNew<typeof iterativeTestWorkflow>({
      ...input, iteration, currentInputs, result,
    });
  }
}
return { result, totalIterations: iteration };
```

**Review board (parallel multi-agent dispatch with aggregation)**:
```typescript
const verdicts = await Promise.all(
  reviewers.map((r) => dispatchReviewer(r, input))
);
const decision = aggregateVerdicts(verdicts);
if (decision.outcome === 'block') {
  return { phase: 'plan-gate-blocked', decision };
}
```

### 7.4 Phased build plan

**Phase 0 — Skeleton (1 week)**.
- `temporal server start-dev` running locally.
- Worker registers a single hello-world workflow.
- Web UI confirms workflow execution; SDK upgrade story validated.
- Choose: Postgres backend now or after pilot. (Default: dev mode + SQLite for first 4 weeks.)

**Phase 1 — Single-agent pipeline (1 week)**.
- One workflow that dispatches one Claude agent activity end-to-end.
- Activity wraps `claude -p --output-format stream-json` and streams output.
- Workflow captures completion, persists summary.
- Confirms the activity heartbeat pattern works for long Claude runs.

**Phase 2 — Multi-agent sequential pipeline (2 weeks)**.
- `scout → planner → coder → tester → reviewer → git-ops` modeled as activities in one workflow.
- Per-activity retry policy.
- Crash recovery test: kill the worker mid-pipeline, restart, confirm resume from failed activity.

**Phase 3 — Long-running activity + human gate (2 weeks)**.
- 12-hour hardware test as a long-running activity with `heartbeatTimeout` and per-step heartbeat.
- Multi-day human gate as `condition()` + signal.
- Web UI to send the signal (browser button posts to API; API calls Temporal client `signal` method).

**Phase 4 — Iterative loop + parallel fan-out (2 weeks)**.
- Test-adjust loop with `continueAsNew` at iteration boundary.
- Review board parallel fan-out with aggregation.
- Establish patterns for the project's most common workflow shapes.

**Phase 5 — Production readiness (1–2 weeks)**.
- Switch to Postgres-backed Temporal server.
- Docker Compose for full stack (server + Postgres + worker + app).
- Observability: workflow metrics, activity failure rates, per-workflow runtime distribution.
- Operational runbook: how to inspect, terminate, signal, and replay workflows.

Total: 9–11 weeks for a production-ready foundation supporting all the workflow shapes described.

### 7.5 Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Determinism violations in workflow code | High during ramp-up | Medium | Enable Temporal's determinism checker in tests; never import Node built-ins in workflow files; treat any non-deterministic API (Date, Math.random) as forbidden — use `workflow.now()` and `workflow.random()` instead |
| Activity-side retries amplify side effects | Medium | High (e.g., double git push) | Make every activity idempotent; use idempotency keys for external API calls; for git, check remote state before pushing |
| Event history grows beyond 51,200 events | Medium for iterative loops | High (workflow termination) | Enforce `continueAsNew` at every loop boundary; monitor event counts via `workflowInfo().continueAsNewSuggested` |
| Ramp-up cost on workflow vs activity boundary | High | Low–Medium | Pair-program first 2–3 workflows; code-review explicitly checks workflow/activity boundary; canonical examples in the repo for each pattern |
| Postgres operational discipline | Low | Medium | Backup script in repo; restore drill in onboarding; default dev mode uses SQLite to defer this risk |

---

## 8. Decision Record

**Decision (revised):** Build the new agentic SDLC system on **Temporal.io**. Use the dev-mode binary + SQLite for the first 4–6 weeks; switch to Postgres-backed deployment when the workload justifies durability investment.

**Primary alternative:** Conductor OSS — chosen if the project pivots toward declarative JSON workflows, dynamic workflow generation by higher-order agents, or a polyglot worker requirement (Python ML + Go + TS).

**Eliminated:** Prefect (no Node SDK; CRASHED-on-restart hostile to long workloads), LangGraph JS (bug #1308 + recursion limit + no per-node timeout disqualify for 12+ hour sessions), Inngest (2-hour per-step cap and step-in-loop anti-pattern do not fit the workload).

**Trigger to revisit:** Conductor becomes preferable if (a) workflow generation by agents becomes a primary product feature, (b) polyglot workers become unavoidable, or (c) Temporal's determinism constraints prove a sustained drag on velocity beyond the 4-week ramp.

---

## Appendix A: Why the prior recommendation changed

The prior version of this document recommended LangGraph (JS) for two reasons that no longer apply:

1. **"Minor adapter" advantage.** Predicated on integrating into the existing architect Node.js dashboard. In a greenfield project there is nothing to adapt to; this advantage drops to zero weight.
2. **Sub-day pipeline assumption.** Predicated on 6–16 step pipelines completing in hours. In multi-day sessions, LangGraph's open bug #1308 (resume-from-checkpoint replays from start) flips from "manageable risk" to "critical correctness defect" — losing 12 hours of test progress is not recoverable through version pinning alone, because pinning trades feature currency for stability and the bug's fix status remains uncertain.

The earlier scoring (LangGraph 8/10, Temporal 8/10) was correct under those constraints. Re-scoring under the revised constraints, the order is Temporal 9/10, Conductor 7/10, LangGraph 5/10, Inngest 4/10, Prefect 2/10. The change is not a rejection of LangGraph as a framework — it is a recognition that the workload changed.
