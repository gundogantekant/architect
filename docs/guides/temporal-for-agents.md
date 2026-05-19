# Temporal for Agents — Integration Guide

**Audience**: Engineers introducing Temporal to a greenfield (or near-greenfield) agentic project — Neuronic Brain being the primary case.

**Scope**: How Temporal fits an agent-dispatch system that already uses Claude Code skills, agents, and the architect portfolio. Not a Temporal tutorial. Not a re-evaluation of framework choice — that decision is recorded in [`../research/workflow-orchestration-frameworks.md`](../research/workflow-orchestration-frameworks.md).

**Not scope**: The architect dashboard itself does not use Temporal — see [`../adr/temporal-feasibility.md`](../adr/temporal-feasibility.md) for the reasoning. This guide applies only to projects with greenfield orchestration needs.

---

## 1. The mental model

Two runtimes, two responsibilities:

| Runtime | Responsibility |
|---|---|
| **Temporal** | Durable spine. Owns workflow state, retries, scheduling, signals, parallel/serial coordination across activities. Survives crashes and restarts. Spans hours to days. |
| **Claude Code CLI** | Agent runtime. Owns the agent tree, skill loading, tool invocation, MCP servers, sub-agent dispatch, conversation context. Lives inside one activity invocation. |

The pattern is: **Temporal between activities, Claude Code inside activities.** A long-running workflow steps through phases (triage → plan → review → implement → test → ship) as Temporal activities. Each activity shells out to `claude -p` and uses skills + agents natively. When the activity returns, Temporal records the result in event history and decides what to do next.

This separation is the entire architectural bet. The two tools are complementary, not competing.

---

## 2. Skills vs Temporal — what actually differs

A common confusion: both can be packaged as markdown files in folders, so it looks like a stylistic choice. It isn't. The difference is the **execution model**, not the file layout.

| | Claude Code skill | Temporal workflow |
|---|---|---|
| Runtime | LLM reads the markdown and improvises in a conversation | Deterministic state machine; activities do the side effects |
| State on crash | Lost with the session | Persisted in event history; resumes at the unfinished activity |
| Span | Single conversation (minutes to hours, context-window bounded) | Indefinite (days, months, unbounded with `continueAsNew`) |
| Trigger | User message, slash command | API call, signal, cron, event |
| Multi-actor | One conversation, one user | Many actors signal the same workflow over its lifetime |
| Audit | Conversation transcript | Every input/output recorded; replayable |
| Cost shape | Per token | Per token *plus* Temporal infra |

**Rule of thumb**: if the work finishes in one conversation and a process crash is acceptable, a skill is the right tool. If the work spans days, coordinates multiple actors, or must survive infrastructure failures, you need Temporal's runtime regardless of how the source files are organized.

---

## 3. The integration pattern: `dispatch_agent` activity

The core primitive is a single generic activity that runs a Claude Code session.

```typescript
// activities/dispatch-agent.ts
import { spawn } from 'child_process';
import { activityContext } from '@temporalio/activity';

export interface DispatchAgentInput {
  role: string;              // "coder-backend", "tester", "reviewer", etc.
  skill?: string;            // optional: "/implement", "/review", etc.
  payload: Record<string, unknown>;
  contextRefs: string[];     // portfolio entries, work item IDs, file paths
  workItemId?: string;
}

export interface DispatchAgentResult {
  output: string;
  exitCode: number;
  sessionId: string;
  tokenUsage: { input: number; output: number };
}

export async function dispatchAgent(input: DispatchAgentInput): Promise<DispatchAgentResult> {
  const ctx = activityContext();
  const prompt = buildPrompt(input);  // composes role brief + skill invocation + payload
  const child = spawn('claude', ['-p', '--output-format', 'stream-json', prompt], {
    cwd: input.payload.cwd as string,
  });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    ctx.heartbeat({ bytesReceived: buffer.length });  // keep Temporal aware
  });

  const exitCode: number = await new Promise((resolve) => child.on('close', resolve));
  return parseFinalResult(buffer, exitCode);
}
```

**Why this shape works**:

- **One activity = one Claude Code session.** Inside the subprocess, the Skill tool, Agent tool, MCP servers, and architect's own sub-agent tree all work natively. You don't reimplement any of it.
- **Dynamic dispatch with no hard bindings.** The activity takes `role` as a string parameter. Adding a new agent type means adding a new role to your registry — no workflow code changes, no activity code changes.
- **Heartbeats keep Temporal alive.** Each chunk of streamed output is a heartbeat. If the activity hangs (or the worker dies), Temporal's heartbeat timeout catches it and schedules a retry.
- **Single-arg constraint satisfied.** All inputs are wrapped in `DispatchAgentInput`. If your Temporal worker enforces single-arg activities (a Python SDK convention you've used in Neuronic Brain), this is the correct shape.

**What the workflow looks like**:

```typescript
// workflows/sdlc-pipeline.ts
export async function sdlcPipeline(workItem: WorkItem): Promise<PipelineResult> {
  const triage = await dispatchAgent({ role: 'classifier', payload: workItem, ... });
  const plan = await dispatchAgent({ role: 'planner', payload: { ...workItem, triage }, ... });
  const verdicts = await Promise.all([
    dispatchAgent({ role: 'tech-reviewer-arch', payload: { plan }, ... }),
    dispatchAgent({ role: 'tech-reviewer-swe',  payload: { plan }, ... }),
    dispatchAgent({ role: 'tech-reviewer-pm',   payload: { plan }, ... }),
  ]);
  if (anyBlocked(verdicts)) return { status: 'plan-blocked', verdicts };

  const code = await dispatchAgent({ role: 'coder', payload: { plan }, ... });
  const tests = await dispatchAgent({ role: 'tester', payload: { code }, ... });
  await dispatchAgent({ role: 'git-ops', payload: { branch: workItem.branch }, ... });
  return { status: 'done', code, tests };
}
```

The workflow reads as straight-line procedural code. Temporal handles the durability invisibly. The same patterns the architect already names — sequential pipeline, parallel fan-out, plan-then-execute, investigate-then-fix — translate one-to-one. See [`../workflows.md`](../workflows.md) for the pattern definitions.

---

## 4. Concurrency: parallel by default, three serialization options

Temporal gives you three patterns for serialization. Pick the lightest one that solves the actual contention.

### 4.1 Parallel (default)

`Promise.all` (TS) or `asyncio.gather` (Python). No setup. Each call is an independent activity execution with its own retries, timeouts, and event history.

```typescript
const results = await Promise.all([
  dispatchAgent({ role: 'coder-frontend', ... }),
  dispatchAgent({ role: 'coder-backend',  ... }),
  dispatchAgent({ role: 'coder-infra',    ... }),
]);
```

You can fire the same role in parallel any number of times — there is no built-in limit.

### 4.2 Global serial queue — dedicated task queue, worker concurrency = 1

For operations that must never overlap *anywhere* (your "merge to base branch" case in its simplest form):

- Run one worker with `maxConcurrentActivityExecutionsPerWorker: 1` listening on a dedicated `git-serial` task queue.
- Route the activity to that queue: `proxyActivities({ taskQueue: 'git-serial', ... })`.
- Concurrent dispatches queue FIFO automatically.

No additional workflow code, no locks, no manual coordination. Cheap and sufficient when there is one shared resource.

### 4.3 Per-resource mutex — long-lived lock workflow

For "parallel across branches, serial within a branch" — branch A and branch B can merge concurrently, but two attempts on branch A must serialize:

- Run one long-lived `BranchLockWorkflow` per branch (keyed by branch name as workflow ID).
- Other workflows send a `RequestLock(requesterId)` signal, await a `LockGranted` signal, do the merge activity, send `ReleaseLock`.
- Temporal's documented mutex pattern; the lock workflow itself is durable.

Use this only when contention is real. It is more code than 4.2.

### 4.4 Picking between them

| Symptom | Pattern |
|---|---|
| "These N things are independent." | 4.1 |
| "Only one of these should run at a time, no matter which branch." | 4.2 |
| "Two on the same branch must serialize, but different branches are fine." | 4.3 |

For Neuronic Brain specifically: start with 4.2 for the git-merge activity. Upgrade to 4.3 only if you start seeing parallel branches actually blocking each other and you want them concurrent.

---

## 5. What you build vs. what each tool gives you

| Capability | Claude Code gives you | Temporal gives you | You build |
|---|---|---|---|
| Sub-agent dispatch tree | Yes (Agent tool, role filtering, tool subsetting) | — | — |
| Skill loading from markdown | Yes (Skill tool) | — | — |
| MCP servers | Yes | — | — |
| Per-agent context window | Yes | — | — |
| Crash recovery mid-workflow | — | Yes (event history replay) | — |
| Retries with backoff | — | Yes (per-activity retry policy) | — |
| Indefinite human gates | — | Yes (`condition()` + signal, zero-cost wait) | — |
| Scheduled triggers | — | Yes (cron, signals) | — |
| Per-resource serialization | — | Yes (task queues + mutex workflows) | — |
| Audit trail / replay | — | Yes (event history) | — |
| `dispatch_agent` activity itself | — | — | ~80 lines |
| Role → prompt template mapping | Pattern documented in architect | — | Small registry + loader |
| Skill markdown files available to worker | — | — | Docker image or shared volume |

The "you build" column is roughly **one engineer-week of glue code** for a working end-to-end pipeline (matches Phase 1 in the research doc's build plan). The Temporal infra (server + Postgres + worker) is another few days. Everything else is Claude Code's responsibility, and you should not reimplement it.

---

## 6. Introducing Temporal incrementally to Neuronic Brain

This is a condensed on-ramp. The full phased plan lives in [`../research/workflow-orchestration-frameworks.md` §7.4](../research/workflow-orchestration-frameworks.md).

### Phase 0 — Local Temporal running (30 minutes)

- Install Temporal CLI: `brew install temporal`.
- Start dev server: `temporal server start-dev`. Web UI on `http://localhost:8233`.
- Confirm: open the UI, see an empty namespace.

No code changes yet. This is just verifying the runtime works on your machine.

### Phase 1 — One workflow, one activity, one Claude Code call (1–2 days)

- Pick the smallest meaningful workflow in Neuronic Brain — e.g., "triage a work item and return a classification."
- Write one `dispatchAgent` activity (the shape in §3).
- Write one workflow that calls it once and returns the result.
- Start a worker that registers both.
- Trigger the workflow from a small script (or your existing entry point).

Test goal: kill the worker mid-Claude-run. Restart it. Confirm the workflow resumes and the activity re-runs to completion. **If this works, the rest of the architecture is mechanical.**

### Phase 2 — Multi-step sequential pipeline (1 week)

- Add planner, coder, tester, reviewer activities (all delegating to the same `dispatchAgent` with different `role` values).
- Compose them in a single workflow as a sequential pipeline.
- Add per-activity retry policies.
- Crash test again: kill the worker between activities — confirm resume from the failed step, not the start.

### Phase 3 — Parallel fan-out + git serialization (1 week)

- Add the review board as `Promise.all` over reviewer activities (pattern 4.1).
- Add the git-merge activity on a dedicated `git-serial` task queue with worker concurrency = 1 (pattern 4.2).
- Fire two pipelines concurrently and confirm: reviewers run in parallel; only one merge runs at a time.

### Phase 4 — Human gates and long-running activities (1–2 weeks)

- Add a human approval gate using `condition()` + signal. Build a tiny UI button (or use the Temporal UI's signal feature) to send the signal.
- Add one long-running activity (e.g., a hardware test) with `heartbeatTimeout` and `activity.heartbeat()` calls.
- Confirm the workflow suspends with zero compute cost during the wait.

### Phase 5 — Production posture (1–2 weeks)

- Switch the dev-mode SQLite backend to a Postgres-backed Temporal server.
- Docker Compose for the full stack (server + Postgres + worker + app).
- Observability: workflow metrics, activity failure rates, per-workflow runtime.
- Backup + restore drill for Postgres.

Total realistic timeline: **6–8 weeks** from zero to a production-ready durable agent pipeline, matching the research doc's estimate within tolerance.

---

## 7. Caveats and constraints specific to this stack

These are the sharp edges you will hit. None are blockers; all are knowable up front.

- **Workflow determinism.** Workflow code must be deterministic — no `Date.now()`, no `Math.random()`, no direct I/O, no Node built-ins. Use `workflow.now()` and `workflow.random()`. The SDK's determinism checker catches violations in tests; enable it.
- **Activities must be idempotent.** Retries happen. A git push activity that doesn't check remote state first will double-push. An API call without an idempotency key will double-charge. Make every activity safe to re-run.
- **Single-arg activities (per Neuronic Brain convention).** Wrap inputs in a single dataclass/interface — `DispatchAgentInput` above is the template.
- **Skill markdown availability.** The worker process must have access to the `.claude/skills/` and `.claude/agents/` markdown files. Either bake them into the worker's Docker image, mount a shared volume, or pull from git on worker startup.
- **Activity timeouts.** Claude Code runs can last minutes to hours. Set `startToCloseTimeout` generously (24h is reasonable for long runs) and rely on `heartbeatTimeout` (e.g., 5 minutes) to catch true hangs.
- **Non-determinism of LLM output.** Replay does not re-invoke the LLM — Temporal records the actual output of each activity in event history and uses the recorded result during replay. This is correct and intended; it just means your activity outputs are not bit-for-bit reproducible from inputs.
- **Cost shape.** Each activity invocation is a real Claude Code session with real API spend. Log session ID + token usage in every activity result so Temporal events correlate with Claude usage. Budget for it.
- **Event history limit (51,200 events per workflow run).** For iterative loops, call `continueAsNew` at the loop boundary to flush history. Check `workflowInfo().continueAsNewSuggested` and respect it.

---

## 8. When *not* to use Temporal here

- The workflow finishes in one conversation, doesn't span actors, and a crash is acceptable → just use a Claude Code skill.
- You want to share PTY/tmux state across a server restart → see [`../adr/temporal-feasibility.md`](../adr/temporal-feasibility.md); Temporal's execution model can't carry file descriptors.
- You need real-time streaming output back to a UI during a single activity → Temporal's "return a result" model fights you. Pair it with a separate streaming channel (WebSocket, SSE) for live output and let Temporal own only durable phase transitions.

---

## 9. References

- [`../research/workflow-orchestration-frameworks.md`](../research/workflow-orchestration-frameworks.md) — full framework evaluation, pattern catalogue, phased build plan
- [`../adr/temporal-feasibility.md`](../adr/temporal-feasibility.md) — why the architect dashboard itself does *not* use Temporal
- [`../workflows.md`](../workflows.md) — multi-agent workflow patterns (sequential, fan-out, plan-then-execute, etc.) that map one-to-one to Temporal workflows
- [`../dispatch.md`](../dispatch.md) — current dispatch lifecycle in the architect dashboard, for contrast
- [`../agents.md`](../agents.md) — agent dispatch guide and coordination patterns
- Temporal TypeScript SDK: <https://docs.temporal.io/develop/typescript>
- Temporal Python SDK: <https://docs.temporal.io/develop/python>
- Mutex workflow pattern: <https://temporal.io/blog/lock-on-shared-resource-using-temporal>
