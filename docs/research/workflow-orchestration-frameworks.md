# Workflow Orchestration Frameworks: Research and Recommendation

**Work item:** W-964
**Date:** 2026-05-01
**Status:** Final
**Decision required:** Adopt a workflow orchestration framework to close five durability and lifecycle gaps in the architect dispatch system.

---

## 1. Executive Summary

**Adopt LangGraph (JS) as the immediate integration target. Treat Temporal.io as a strategic upgrade path reserved for a future autonomous-agent posture. Reject Prefect. Defer Conductor OSS and Inngest.**

LangGraph is the only finalist that closes four of the five identified gaps with a *minor adapter* refinement profile — same Node.js process, same SQLite file, no second daemon, no new lifecycle to manage by `dashctl.sh`, MIT-licensed, 1.0 GA, TypeScript-native. The remaining gap (durable human-in-the-loop) is solved by `interrupt()` plus `SqliteSaver`, with one known JS-only correctness bug (#1308) that is mitigable by version pinning and a dedicated integration test.

Every other finalist requires a major rewrite of the dispatch layer for advantages that the current scale (6–16 step pipelines, single-developer laptop, local-first) does not yet justify.

---

## 2. Framework Comparison Matrix

| Criterion | Temporal.io | Prefect | Conductor OSS | LangGraph (JS) | Inngest |
|---|---|---|---|---|---|
| **Node.js SDK gate** | PASS 5/5 — `@temporalio/*` v1.17, production-grade | **FAIL 1/5** — no SDK, REST only | PASS 3/5 — `@io-orkes/conductor-javascript` v3.0.3, low adoption | PASS 5/5 — `@langchain/langgraph` v1.2.9, 42k weekly | PASS 5/5 — `inngest` v4.2.6 |
| **Self-host gate** | PASS 5/5 — `start-dev` single binary + SQLite, MIT | PASS 5/5 — pip + one command | PASS 4/5 — JVM + Postgres + Docker | PASS 5/5 — pure library, no server | PASS 4/5 — single binary, separate process |
| **Long-running** | 5/5 — `condition()`, `continueAsNew`, replay | 2/5 — flows can falsely CRASH on restart | 5/5 — WAIT, WAIT_FOR_WEBHOOK, HUMAN tasks | 3/5 — `interrupt()` + checkpointer; bug #1308 | 3/5 — `step.sleep` 1y, but `waitForEvent` requires timeout |
| **Contractual** | 4/5 — typed activities + Updates + nonRetryableErrorTypes | 2/5 — no veto-on-completion primitive | 3/5 — JSON Schema on outputs (Simple/Yield only) | 3/5 — typed state + verifier nodes | 4/5 — `step.invoke()` strongest composition |
| **Sequential** | 5/5 — immutable event history, determinism check | 3/5 — checkpoints persisted, in-process work isn't | 5/5 — DAG enforced by State Machine Evaluator | 4/5 — graph edges + `sync` checkpointer (bug #1308) | 5/5 — step memoization, no equivalent bug |
| **Retry** | 5/5 — per-activity policy, heartbeats | 5/5 — task-level config | 5/5 — exponential, jitter, failureWorkflow | 5/5 — per-node RetryPolicy, independent counters | 5/5 — per-step, `RetryAfterError`, `onFailure` |
| **Complexity** | 3/5 — determinism + replay learning curve | 4/5 — easy start, doubles runtime surface | 3/5 — JVM + Postgres + Docker added | 5/5 — npm install, point at existing DB | 3/5 — second managed process |
| **Refinement classification** | major rewrite | major rewrite | major rewrite | **minor adapter** | major rewrite |
| **Final score** | 8/10 | 3/10 (eliminated) | 7/10 | **8/10 (recommended)** | 6/10 |

LangGraph and Temporal tie on numerical score; LangGraph wins on cost-of-adoption (minor adapter vs major rewrite) for the architect's current scale and locality constraints. The tie-breaker is integration overhead, not capability.

---

## 3. Eliminated Frameworks

### Prefect — eliminated at SDK gate

Prefect has no Node.js / TypeScript SDK. The corresponding GitHub issue is closed as not planned. Node.js can only act as a REST client; all flow definitions must run in Python. This forces one of two unacceptable shapes:

- **Polyglot runtime:** add a Python orchestrator process alongside the Node.js dashboard. Doubles per-process surface area, doubles dependency management, doubles `dashctl.sh` lifecycle complexity.
- **Total rewrite:** port dispatch, work-tracking, dashboard, and every skill workflow to Python.

Even ignoring the SDK gate, Prefect's long-running posture is weaker than the architect's current PID-tracking model: heartbeat-driven automations can mark in-flight flows as `CRASHED` after a server restart, the opposite of the durability the project is trying to add. Eliminated.

---

## 4. Per-Framework Analysis (Finalists)

### 4.1 Temporal.io — fit 8/10, refinement: major rewrite

**Strengths**
- Strongest durability guarantees of the entire field. Workflow state is reconstructed from an immutable event history; ordering is enforced by the runtime, not by code conventions.
- `workflow.condition()` suspends a workflow with zero compute cost until a signal arrives — the cleanest primitive in the field for review-board gates and indefinite human waits.
- `continueAsNew` resets the per-workflow event-history limit (51,200 events), enabling truly unbounded runs.
- Per-activity retry policy is exhaustive: `initialInterval`, `backoffCoefficient`, `maximumInterval`, `maximumAttempts`, `nonRetryableErrorTypes`, plus heartbeat timeouts for hung work.
- Production-proven at scale (Stripe, Datadog, Snap).

**Weaknesses**
- Workflow code must be deterministic. No `Date.now()`, no `Math.random()`, no Node `fs`, no direct network calls — all side effects move into activities. This is the single largest conceptual hurdle.
- Production deployment requires a Postgres instance and a long-lived Temporal server; dev mode is fine, but the moment durability matters in a multi-day session, ops surface area grows.
- DispatchContract has no native primitive. Goal/Constraints/Expected Output must be lifted out of Markdown prose into typed activity code, creating two sources of truth (the prose contract for humans, the typed evaluator for the runtime).
- Learning curve: 1–2 weeks for a Node.js developer to internalize determinism, replay, activity vs. workflow boundary, and event sourcing.

**Verdict**
Temporal is the technically strongest option. Its cost is justified only when architect runs *multi-day, autonomous* sessions where event-sourced replay is the difference between a system that recovers and one that loses work. The current scale (6–16 step pipelines, developer laptop, single-process dashboard) does not yet justify the ops surface area or the rewrite. Hold as the strategic upgrade path.

---

### 4.2 Conductor OSS — fit 7/10, refinement: major rewrite

**Strengths**
- WAIT, WAIT_FOR_WEBHOOK, and HUMAN task types provide a first-class, indefinite-suspension model with no time ceiling.
- JSON Schema (draft 2020-12) on task outputs is the only declarative contract enforcement in the field. Structural shape of `expected_output` becomes a runtime guarantee, not a prose convention.
- DAG ordering enforced by the State Machine Evaluator at the execution layer, not by conversational discipline.
- Mature retry semantics: `EXPONENTIAL_BACKOFF` with `retryDelaySeconds`, `backoffScaleFactor`, `backoffJitterMs`, `totalTimeoutSeconds`, plus `failureWorkflow` for compensation.
- Apache 2.0 license, well-known production references.

**Weaknesses**
- Stack overhead is the heaviest of all finalists: JVM Conductor server + Docker + Postgres on top of the existing Node + SQLite. ARM64 Elasticsearch is unstable; the workaround is Postgres-only mode.
- JavaScript SDK has 52 GitHub stars and visibly lags the Java SDK; an HTTP/2 bug is currently open. Acceptable for a side experiment, fragile for a primary dependency.
- Workflows are JSON DAGs registered with the server. The dashboard's current "spawn `claude -p` as a child" pattern must be re-plumbed: Claude sub-agents become polling task workers; work-item status must be sourced from Conductor APIs.
- JSON Schema enforcement currently applies only to Simple and Yield tasks, so partial coverage; value-level predicates still require explicit verifier tasks.

**Verdict**
Schema-on-outputs is genuinely attractive for closing the contractual gap, and HUMAN tasks elegantly model the review board. But the JVM + Postgres + Docker overhead, the lagging JS SDK, and the major-rewrite cost outweigh that single advantage at the architect's current scale. Defer.

---

### 4.3 LangGraph (JS) — fit 8/10, refinement: minor adapter — **RECOMMENDED**

**Strengths**
- Pure embedded TypeScript library. `npm install @langchain/langgraph`, point `SqliteSaver` at the existing `work/architect.db`, register the graph. No second process, no Docker, no port, no `dashctl.sh` change.
- 1.0 GA, MIT, 42k+ weekly npm downloads — by far the highest community velocity of the finalists in JS land.
- `interrupt()` plus `SqliteSaver` gives a durable, indefinite, human-in-the-loop wait — the exact primitive needed for review-board gates.
- Graph edges enforce ordering as code; conditional edges naturally express the verifier-node pattern.
- Per-node retry policy (`maxAttempts`, `initialInterval`, `backoffFactor`, `maxInterval`, `jitter`, `retryOn` predicate) with independent counters; completed nodes are not re-executed on resume.
- DispatchContract maps to a typed state field — an immediate semantic upgrade from prose-only contracts.

**Weaknesses**
- Default recursion limit is 25; the longest current pipeline (16 sequential steps × 2 retry passes plus safety margin) requires raising the cap to ≥50 explicitly.
- No per-node timeout primitive — hung nodes need `Promise.race` wrappers.
- Open bug #1308: under specific conditions, the JS resume-from-checkpoint path replays from the beginning rather than the saved superstep. This is the single critical correctness risk on the recommended path. Mitigation: pin to a verified-fixed version and write an integration test that crashes mid-pipeline and asserts the resume cursor.
- DispatchContract's Scope Boundary and Stop Conditions remain prompt-level guardrails unless a custom state interceptor is written; the framework does not natively veto agent output that exceeds scope.

**Verdict**
LangGraph is the only finalist where the integration cost is "wire a graph at dispatch time" rather than "rebuild the dispatch system around an external runtime." It closes durable execution plan, per-step state machine, automatic retry, and sequential enforcement gaps in one library install. The remaining gap (durable human-in-the-loop) is solved by `interrupt()` once bug #1308 is mitigated. Recommended.

---

### 4.4 Inngest — fit 6/10, refinement: major rewrite

**Strengths**
- TypeScript-native SDK, MIT-licensed.
- Step memoization is the strongest durability primitive in the field after Temporal — and unlike LangGraph there is no equivalent of bug #1308.
- `step.invoke()` is the cleanest composition primitive in the finalists: parent awaits child with the full retry cycle before proceeding. This maps unusually well to the architect's "dispatch a sub-agent and wait for its contractual completion" idiom.
- `step.sleep()` durably suspends for up to a year; `NonRetriableError` and `onFailure` handle hard violations and compensation cleanly.

**Weaknesses**
- Event-driven design requires re-expressing DispatchPlan as event payloads plus step chains. The dashboard's "spawn `claude -p` as a child process" pattern must be replaced with Inngest functions invoking Claude inside a step.
- Anti-pattern: step calls inside loops. Existing autonomous loop patterns must be refactored into event-driven fan-outs.
- Hard limits: 1000 steps per run, 2hr per-step cap. Adequate for current pipelines, but a ceiling that future autonomous-loop workloads might hit.
- Server SSPL-licensed (internal use unrestricted, but not OSI Open Source). The single-binary self-host adds a second managed process and another `dashctl.sh` lifecycle.

**Verdict**
Excellent durability and composition primitives, but the cost is a major rewrite of the dispatch layer for capabilities that LangGraph approximates well enough at the current scale. If LangGraph's bug #1308 mitigation proved unreliable in the pilot, Inngest would be the second-best non-Temporal pivot. Defer.

---

## 5. Long-Running Task Autonomy

The architect needs three long-running shapes: (a) review-board gates that can block for hours or days awaiting human verdicts; (b) autonomous loops that iterate `coder → tester → review → revise` until a contract is satisfied; (c) crash recovery where the dashboard process is restarted mid-pipeline and the in-flight work resumes.

| Concern | Temporal | Conductor | LangGraph | Inngest |
|---|---|---|---|---|
| **Indefinite suspension** | `workflow.condition()` — zero compute, signal-driven | WAIT / WAIT_FOR_WEBHOOK / HUMAN — no ceiling | `interrupt()` + checkpointer — no timeout | `step.sleep()` 1y; `waitForEvent` *requires* timeout |
| **Crash recovery** | Deterministic replay from event history | Postgres-resumed exactly | Resume from last checkpoint (bug #1308 caveat) | Resume from last memoized step |
| **Loop pattern** | `while (!ok) { await activity(); await signal; }` + `continueAsNew` at gate boundaries | Iterative DO_WHILE on workflow definition | Cyclic graph + `interrupt()` for human gate | Event-driven fan-out (anti-pattern: step-in-loop) |
| **Practical ceiling** | None — `continueAsNew` resets event limit | None | Recursion limit (configurable; raise to ≥50) | 1000 steps / 2hr per step |
| **Critical risk** | Determinism violations cause replay failures | JVM ops surface | Bug #1308 — must mitigate | Step-in-loop refactor cost |

**For the architect's current pipelines (6–16 steps, hours-to-days human gates):** LangGraph's `interrupt()` plus `SqliteSaver` is sufficient once bug #1308 is mitigated and the recursion limit is raised. Temporal is overengineered for the current scale and the right answer for a future multi-day autonomous posture. Conductor and Inngest both work but at the cost of a second daemon and a major rewrite.

---

## 6. Contractual Terms — DispatchContract Mapping

The DispatchContract entity has six fields: Goal, Constraints, Expected Output, Failure Conditions, Scope Boundary, Stop Conditions. None of the finalists provides a single native primitive that covers all six; each requires a composition pattern.

| Contract field | Temporal | Conductor | LangGraph | Inngest |
|---|---|---|---|---|
| **Goal** | Workflow input parameter — auditable in event history | Task definition metadata | State field — typed | Event payload field |
| **Constraints** | Workflow input + activity preconditions | Task input parameters | State field consulted by nodes | Event payload + step preconditions |
| **Expected Output** | Activity return type + verification activity | JSON Schema on output (declarative) | Verifier node + conditional edge | `step.invoke()` return type + verifier step |
| **Failure Conditions** | `nonRetryableErrorTypes` on typed exceptions | Worker returns FAILED_WITH_TERMINAL_ERROR | Verifier sets error state; conditional edge routes | `NonRetriableError` |
| **Scope Boundary** | Guard activity at loop start throws ScopeExceededError | Verifier task post each agent | Prompt-level; custom state interceptor for runtime check | `step.run` precondition |
| **Stop Conditions** | Same guard activity | Same verifier task | Same custom interceptor | Same precondition |

**Conductor's JSON Schema enforcement is uniquely declarative** — structural shape of Expected Output is enforced by the runtime without writing verifier code. **Temporal's typed activities plus `nonRetryableErrorTypes` give the strongest typed-failure semantics.** **LangGraph's verifier-node pattern doubles node count** but elevates contracts from prose to a structured runtime artifact, a meaningful improvement over the current Markdown-only model. **Inngest's `step.invoke()`** offers the cleanest composition: the parent literally awaits the child's full retry-and-completion cycle before proceeding, which maps tightly to the architect's "dispatch and wait for contractual completion" idiom.

For LangGraph specifically, the recommended pattern per dispatch step is:

```
[agentNode] → [verifierNode] → conditional edge ──ok──→ next step
                                                ├──retry─→ agentNode (bounded)
                                                └─escalate→ humanGateNode (interrupt)
```

The DispatchContract becomes a typed `Contract` field on the graph state, consulted by every verifier node. Goal and Constraints stay in prose for human readability; Expected Output and Failure Conditions become typed predicates evaluated by the verifier. Scope Boundary and Stop Conditions remain prompt-level for now and can be promoted to a state interceptor in a follow-on item if pilot data shows agents drifting out of scope.

---

## 7. Recommendation and Justification

### 7.1 Primary recommendation: adopt LangGraph (JS)

**Decision: integrate LangGraph as a thin adapter over the existing dispatch layer. Pin the version to a release with bug #1308 verified fixed. Use the existing `work/architect.db` as the checkpoint store via `SqliteSaver`.**

Rationale, in order of weight:

1. **Refinement classification is "minor adapter," not "major rewrite."** Every other finalist requires reshaping the dispatch layer around an external runtime. LangGraph plugs into the existing Node.js process and the existing SQLite database. The dashboard, work-tracker, agent prompts, and `dashctl.sh` are unchanged.
2. **Closes four of five gaps immediately.** Durable execution plan (graph + checkpointer), per-step state machine (state field + nodes), automatic retry (per-node RetryPolicy), sequential enforcement (graph edges) — all delivered by the library, not by application code.
3. **The fifth gap (durable human-in-the-loop) is solved by `interrupt()` plus `SqliteSaver`** once the version is pinned and an integration test guards against regression of bug #1308.
4. **Zero new operational surface.** No JVM, no Postgres, no Temporal server, no second daemon. `dashctl.sh` does not learn a new lifecycle.
5. **License and ecosystem.** MIT, 1.0 GA, 42k weekly npm downloads, TypeScript-native. The lowest supply-chain risk of any finalist.
6. **DispatchContract semantics are upgraded** from prose-only to typed state plus verifier nodes — a meaningful improvement without forcing a contract rewrite.

### 7.2 Strategic upgrade path: Temporal.io

Hold Temporal as the upgrade path *if and when* architect becomes a multi-day autonomous orchestrator (long autonomous-loop sessions, distributed dispatch across multiple developer machines, durability requirements where event-sourced replay is the difference between recovery and data loss). Until then, Temporal's ops surface area and rewrite cost are not justified by the workload.

### 7.3 Rejected and deferred

- **Rejected — Prefect:** no Node.js SDK; even if bridged, restart-CRASHED behavior is worse than the current PID-tracking model.
- **Deferred — Conductor OSS:** JSON-Schema-on-outputs is attractive but does not pay for the JVM + Postgres + Docker overhead at current scale.
- **Deferred — Inngest:** strongest durability after Temporal and the cleanest composition primitive in the field, but a major rewrite of the dispatch layer for advantages LangGraph approximates well enough.

### 7.4 Phased approach

**Phase 0 — Spike (1 week).** Build a throwaway prototype that wraps the existing `coder → tester → reviewer` pipeline as a LangGraph graph with `SqliteSaver`. Run the integration test for bug #1308 (kill the dashboard mid-pipeline, restart, assert resume cursor). Confirm the recursion-limit and timeout-wrapper choices on the longest skill workflow.

**Phase 1 — Adapter (2 weeks).** Introduce a `WorkflowRunner` adapter in the dispatch layer that accepts a `DispatchPlan` and produces a `StateGraph`. Migrate one skill end to end (`/implement` is the natural target — it has the longest pipeline and the most explicit gates). Keep the legacy in-memory dispatch in place for the other 18 skills; both code paths run in parallel.

**Phase 2 — Migration (3–4 weeks).** Migrate the remaining 18 skills one at a time. Each migration is a per-skill PR. Decommission the legacy in-memory dispatch only after all 19 skills are migrated and have logged at least one full run on the new path.

**Phase 3 — Contract elevation (1 week, optional).** Promote DispatchContract from prose-only to a typed state field. Add verifier nodes after every agent step. Optional state interceptor for Scope Boundary / Stop Conditions if pilot data shows drift.

### 7.5 Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bug #1308 regression on JS resume-from-checkpoint | Medium | High (lost pipeline state) | Pin version; integration test that crashes mid-pipeline and asserts cursor position; gate every dependency bump on the same test |
| Recursion limit hit on deepest pipeline | Low | Medium (workflow halt) | Set limit ≥50 explicitly at graph construction; emit a warning on configuration mismatch |
| Hung agent node with no timeout primitive | Medium | Medium (zombie pipeline) | Wrap every node body in `Promise.race` with the existing dispatch timeout |
| Adapter leak — dashboard depends on graph internals | Low | Medium | Keep `WorkflowRunner` interface narrow; dashboard reads work-item status via existing tracker, not LangGraph internals |
| Vendor abandonment | Very low | Medium | MIT license, embedded library — fork is a viable last resort |

---

## 8. Integration Plan (LangGraph)

### 8.1 What stays unchanged

- `domain/` entity schemas and rules. DispatchContract, WorkItem, DispatchPlan, SessionIdentity stay as defined.
- 19 skill workflow definitions in `usecases/`. They describe intent; LangGraph executes intent.
- 34 agent prompts in `.claude/agents/`. Agents do not learn LangGraph exists.
- `work/architect.db` SQLite database. LangGraph's `SqliteSaver` writes to a new `checkpoints` table in the same file; the existing `work_items`, `dispatches`, `terminals`, `cli_sessions` tables are untouched.
- `dashctl.sh` and the dashboard server lifecycle. No new daemon, no new port.
- The `claude -p --output-format stream-json` child-process pattern. Each agent invocation still spawns a Claude CLI process — it is now invoked from inside a graph node rather than from a dispatcher loop.
- Work-tracker, SSE bridge, tmux terminal sessions, CLI session registration.

### 8.2 What moves

- **DispatchPlan execution:** moves from an in-memory orchestrator loop to a `StateGraph` that is constructed at dispatch time from the same `DispatchPlan` object. Each plan step becomes one or two graph nodes (agent + optional verifier).
- **Per-step state:** moves from a single `status` field on the work item to a typed graph state plus checkpoints. The work item retains its single `status` field for dashboard backward compatibility; the graph state is the source of truth for step-level progress.
- **Retry logic:** moves from manual re-dispatch to `RetryPolicy` on each node.
- **Review-board gating:** moves from "verdict streamed via SSE" to "verdict resolves an `interrupt()` and the graph advances." SSE remains as a presentation layer over the same event stream.
- **Sequential ordering:** moves from `parallel_with` advisory metadata to graph edges enforced by the runtime.

### 8.3 What disappears

- The in-memory dispatcher loop that today owns "what comes next" — replaced by graph topology persisted as checkpoints.
- Manual re-dispatch UX for transient failures — replaced by automatic per-node retry with backoff.
- The implicit assumption that the dashboard process is always alive — graph state survives crashes and restarts.

### 8.4 Architecture layer placement

LangGraph fits cleanly into the **Adapter** layer. Specifically:

- **Domain (unchanged):** DispatchContract, DispatchPlan, WorkItem schemas in `domain/entities.md` and `domain/rules.md`.
- **Use Cases (unchanged):** the 19 skill workflow files in `usecases/` describe what each skill does.
- **Adapters (new module):** a `tools/workflow/` module exposes `WorkflowRunner` and per-skill graph builders. The `WorkflowRunner` takes a `DispatchPlan` (domain object) and returns a compiled `StateGraph` (LangGraph object). This is the only place LangGraph types are imported.
- **Infrastructure (extended):** `work/architect.db` gets a `checkpoints` table written by `SqliteSaver`. The dashboard server module imports `WorkflowRunner` from the adapter, never LangGraph directly.

This placement preserves the dependency rule (dependencies point inward only): LangGraph is an external dependency known only to the adapter; the domain and use cases remain framework-agnostic.

### 8.5 Migration phases (detailed)

**Phase 0 — Spike (1 week).** Working branch, no merge.
- Implement `WorkflowRunner` against the `/implement` skill only.
- Run end-to-end on a real work item.
- Validate bug #1308 mitigation via the integration test.
- Validate recursion limit, timeout wrapper, checkpoint table layout.
- Output: go/no-go decision; if go, scope the adapter PR.

**Phase 1 — Adapter and pilot skill (2 weeks).** Merged to `autonomous` behind a feature flag.
- Build `tools/workflow/` adapter module.
- Add `checkpoints` table to `work/architect.db` via migration.
- Migrate `/implement` to the new path; keep the legacy dispatcher available for all other skills.
- Add the bug-#1308 integration test to CI.
- Document the adapter API in `docs/architecture.md`.

**Phase 2 — Skill migration (3–4 weeks).** One PR per skill, merged to `autonomous`.
- Migrate skills in order of pipeline length (longest first: `/implement`, `/review-board`, `/release`, `/refactor`, `/migrate`, then the rest).
- Each PR adds the skill's graph builder, removes the skill's legacy dispatch path, adds a smoke test.

**Phase 3 — Decommission and contract elevation (1 week, optional).**
- Remove the legacy in-memory dispatcher.
- Promote DispatchContract from prose-only to typed state field across all skill graphs.
- Add verifier nodes after agent steps that have explicit Expected Output predicates.

### 8.6 Risks and operational notes

- **Database growth:** `SqliteSaver` writes a checkpoint per superstep. For 16-step pipelines run weekly, growth is modest; budget a periodic prune of completed-and-old checkpoints (90-day retention is a reasonable starting policy).
- **Concurrency:** LangGraph graphs are not concurrency-bounded; the dashboard already spawns up to N parallel dispatches. The graph runner inherits the dashboard's concurrency budget — no new throttling required.
- **Observability:** existing SSE log streams continue to work; add a `graph_state` field to the dispatch panel for step-level visibility.
- **Testing:** every skill graph needs a smoke test that runs it to completion with mocked agent calls. The bug-#1308 test runs on every CI build.

---

## 9. Proposed Follow-On Work Items

The following work items should be created if this recommendation is accepted. IDs are placeholders; the tracker will assign real ones.

| Proposed ID | Title | Phase | Size | Dependencies |
|---|---|---|---|---|
| W-NEXT-A | Spike: prototype LangGraph wrapper for `/implement` pipeline | 0 | S | — |
| W-NEXT-B | Integration test: crash-mid-pipeline assertion for bug #1308 | 0 | S | W-NEXT-A |
| W-NEXT-C | Build `tools/workflow/` adapter module (`WorkflowRunner` + SQLite checkpoint table migration) | 1 | M | W-NEXT-A, W-NEXT-B |
| W-NEXT-D | Migrate `/implement` skill to LangGraph runner behind feature flag | 1 | M | W-NEXT-C |
| W-NEXT-E | Document adapter API and graph-builder convention in `docs/architecture.md` | 1 | S | W-NEXT-C |
| W-NEXT-F | Migrate `/review-board` skill | 2 | M | W-NEXT-D |
| W-NEXT-G | Migrate `/release`, `/refactor`, `/migrate` skills | 2 | M | W-NEXT-F |
| W-NEXT-H | Migrate remaining 14 skills (one PR each) | 2 | L | W-NEXT-G |
| W-NEXT-I | Decommission legacy in-memory dispatcher | 3 | S | W-NEXT-H |
| W-NEXT-J | Promote DispatchContract to typed state field; add verifier nodes | 3 | M | W-NEXT-I |
| W-NEXT-K | Checkpoint retention policy and prune job | 3 | S | W-NEXT-I |
| W-NEXT-L | (Strategic) Re-evaluate Temporal.io once architect runs multi-day autonomous sessions | future | — | post-pilot data |

Sizing key: S ≈ ≤3 days, M ≈ 1 week, L ≈ 2+ weeks.

---

## 10. Decision Record

**Decision:** adopt LangGraph (JS) as the workflow orchestration framework for the architect dispatch layer. Hold Temporal.io as the strategic upgrade path. Reject Prefect. Defer Conductor OSS and Inngest.

**Trigger to revisit:** if architect's pipelines grow beyond the 6–16 step range into multi-day autonomous loops, or if the bug-#1308 mitigation proves unreliable in the pilot, re-open the comparison between LangGraph, Inngest, and Temporal.

**Owner of follow-on work:** to be assigned via the work items in Section 9.
