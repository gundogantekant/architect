# Temporal Integration Guide — Architect Ecosystem

**Audience**: Engineers working within the architect SDLC system who want to understand where Temporal fits, how to use it, and how the planned integration is structured.

**Scope**: Architect-specific context — the dashboard, the multi-user chat gateway, and multi-project setup. For greenfield agentic project patterns (Neuronic Brain), see [`temporal-for-agents.md`](temporal-for-agents.md).

**Related ADRs**:
- [`../adr/temporal-feasibility.md`](../adr/temporal-feasibility.md) — why Temporal was rejected for the dispatch subprocess layer
- `../adr/temporal-coordination-layer.md` — (pending W-1207) — verdict on the coordination-layer approach

---

## 1. What the ADR Says — and What It Doesn't

ADR-001 rejected Temporal as a **replacement for the dispatch subprocess management layer**. The three blockers are:

1. PTY/tmux file descriptors cannot be serialized into Temporal's event history.
2. Streaming stdout for hours doesn't fit Temporal's activity-completes-and-returns model.
3. Local-only deployment added operational overhead disproportionate to the reliability gain.

**What ADR-001 does NOT foreclose:**

- Temporal as a **coordination layer above** the existing dispatch mechanism.
- Temporal managing the **SDLC workflow state machine** (work item state, sequential/parallel dispatch ordering, escalation signals) while the existing subprocess management handles actual Claude Code sessions.
- Temporal as a **per-user-session orchestrator** in a multi-user chat gateway.

The pending spike (W-1207) will produce ADR-002 that specifically evaluates the coordination-layer approach.

---

## 2. The Layered Architecture

Two runtimes, separate responsibilities:

| Layer | Runtime | Owns |
|-------|---------|------|
| **Dispatch layer** | Node.js dashboard (`dispatch-manager.mjs`) | PTY, subprocess, stdout streaming, JSONL replay, soft-timeout escalation |
| **Coordination layer** | Temporal workflow | SDLC pipeline sequencing, work item state transitions, parallel fan-out, escalation signals, human-in-the-loop |
| **Agent runtime** | Claude Code CLI | Skill loading, sub-agent dispatch, conversation context, MCP servers |

The pattern: **Temporal between activities, Claude Code inside activities, existing dispatch inside the activity.**

```
Temporal Workflow (SDLC Pipeline)
  └── Activity: dispatchAgentActivity(role, workItemId)
        └── POST /api/dispatch   ← existing dashboard API
              └── claude -p ...  ← Claude Code session (PTY, SSE, JSONL)
```

Temporal never sees the PTY or the stdout stream. The activity wraps the existing dispatch API: it POSTs, polls the SSE stream for completion, sends heartbeats every 30s, and returns the result. The ADR's three blockers remain inside the activity boundary.

---

## 3. Dispatch Activity Adapter Pattern

```typescript
// tools/temporal/activities/dispatch-agent.ts
import { activityContext } from '@temporalio/activity';

export interface DispatchAgentInput {
  role: string;              // 'coder-backend', 'tester', 'reviewer', etc.
  workItemId: string;        // 'W-1207'
  projectKey: string;        // 'ticari/architect/main'
  instructions?: string;
  permissionMode?: 'plan' | 'acceptEdits';
}

export interface DispatchAgentResult {
  dispatchId: string;
  status: 'completed' | 'failed' | 'timeout';
  agentPhase: string;
  exitCode: number | null;
}

export async function dispatchAgentActivity(input: DispatchAgentInput): Promise<DispatchAgentResult> {
  const ctx = activityContext();

  // 1. Create dispatch via existing API
  const res = await fetch('http://127.0.0.1:3777/api/dispatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_key: input.projectKey,
      work_item_id: input.workItemId,
      role: input.role,
      instructions: input.instructions ?? '',
      permission_mode: input.permissionMode ?? 'acceptEdits',
    }),
  });
  const { id: dispatchId } = await res.json();

  // 2. Poll for completion, heartbeat every 30s
  while (true) {
    ctx.heartbeat({ dispatchId, phase: 'polling' });

    const status = await fetch(`http://127.0.0.1:3777/api/dispatch/${dispatchId}`)
      .then(r => r.json());

    if (status.status === 'completed' || status.status === 'failed') {
      return {
        dispatchId,
        status: status.status,
        agentPhase: status.agent_phase,
        exitCode: status.exit_code,
      };
    }

    if (status.status === 'timeout') {
      throw new Error(`Dispatch ${dispatchId} timed out`);
    }

    await new Promise(r => setTimeout(r, 30_000)); // 30s poll interval
  }
}
```

**Timeout mapping**: The soft-timeout escalation in `dispatch-manager.mjs` (W-1204) lives inside the activity. The Temporal `scheduleToCloseTimeout` on the activity must be set longer than the dispatch's own timeout. For large work items (120min + 30min extension), set `scheduleToCloseTimeout: '3h'`.

---

## 4. Multi-User Per-Session Orchestrator

Each user login session runs as a dedicated `UserSessionWorkflow`. The workflow is the orchestrator.

### Architecture

```
Browser (Chat UI)
    │ WebSocket / SSE
    ▼
API Gateway (Node.js)
    │ startWorkflow(workflowId: sessionId)
    │ signalWorkflow(sessionId, 'user_message', { text, messageId })
    ▼
Temporal Namespace: "architect" | "new-project"
    ▼
UserSessionWorkflow(sessionId: string)
    ├── on Signal('user_message') → classifyIntentActivity()
    │                             → ragRetrievalActivity()
    │                             → dispatchAgentActivity() or child workflow
    ├── on Signal('approval')    → resume paused gate
    ├── Query('state')           → return conversation state to UI
    └── continueAsNew()          every ~1,000 events
```

### Isolation Model

| Scenario | Temporal Workflows |
|----------|--------------------|
| 3 users, 1 session each | 3 `UserSessionWorkflow` instances (workflowIds: `session-a`, `session-b`, `session-c`) |
| 2 users, 2 sessions each | 4 `UserSessionWorkflow` instances (workflowIds: `user1-sess1`, `user1-sess2`, `user2-sess1`, `user2-sess2`) |
| 10 users, mixed sessions | N workflows, same worker process, no sticky sessions |

Workers process activities from all workflows in parallel. No session affinity required.

### Workflow Sketch

```typescript
// workflows/user-session.ts
import { defineSignal, setHandler, workflow, condition, continueAsNew } from '@temporalio/workflow';
import type { dispatchAgentActivity, classifyIntentActivity, ragRetrievalActivity } from '../activities';

const userMessageSignal = defineSignal<[{ text: string; messageId: string }]>('user_message');
const approvalSignal = defineSignal<[{ approved: boolean }]>('approval');

export async function userSessionWorkflow(sessionId: string): Promise<void> {
  const messages: Array<{ role: string; content: string }> = [];
  let pendingMessage: { text: string; messageId: string } | null = null;
  let awaitingApproval = false;
  let approvalResult: boolean | null = null;
  let eventCount = 0;

  setHandler(userMessageSignal, (msg) => { pendingMessage = msg; });
  setHandler(approvalSignal, (res) => { approvalResult = res.approved; });

  while (true) {
    // Wait for next user message
    await condition(() => pendingMessage !== null);
    const msg = pendingMessage!;
    pendingMessage = null;
    eventCount++;

    // Classify + RAG retrieval (run in parallel)
    const [intent, context] = await Promise.all([
      workflow.executeActivity(classifyIntentActivity, { text: msg.text, history: messages }),
      workflow.executeActivity(ragRetrievalActivity, { query: msg.text, sessionId }),
    ]);

    // Route to appropriate SDLC activity
    const result = await workflow.executeActivity(dispatchAgentActivity, {
      role: intent.agentRole,
      workItemId: intent.workItemId,
      projectKey: intent.projectKey,
    });

    messages.push({ role: 'user', content: msg.text });
    messages.push({ role: 'assistant', content: result.summary });

    // continueAsNew to prevent event history bloat
    if (eventCount >= 1000) {
      await continueAsNew<typeof userSessionWorkflow>(sessionId);
    }
  }
}
```

### Critical Gotchas

| Gotcha | Limit | Mitigation |
|--------|-------|-----------|
| Event history | 51,200 events/execution | `continueAsNew` every ~1,000 turns |
| Signal accumulation | 10,000 signals/execution | Rate-limit user messages at API gateway |
| `continueAsNew` deduplication | No cross-run dedup built-in | Track `messageId` in workflow state; skip duplicates |
| Idle session cleanup | N/A | Set `workflowExecutionTimeout: '2h'`; UI re-creates on next login |

---

## 5. PostgreSQL Multi-Project Setup

Use the existing Docker Postgres instance. One namespace + schema pair per project.

### Schema Layout

```
PostgreSQL (Docker, existing)
├── public                          (architect dashboard tables)
├── ai_chat                         (migration 032: users, conversations, messages, token_usage)
├── architect_temporal              (namespace: architect)
├── architect_temporal_visibility
└── <newproject>_temporal           (add per project via setup.sh --namespace)
```

### Temporal Server Config (`tools/temporal/config/development.yaml`)

```yaml
persistence:
  defaultStore: architect-store
  visibilityStore: architect-visibility
  datastores:
    architect-store:
      sql:
        driver: postgres12
        host: ${DB_HOST:-localhost}
        port: ${DB_PORT:-5432}
        database: ${DB_NAME:-architect_db}
        schemaName: architect_temporal
        user: ${DB_USER}
        password: ${DB_PASS}
        maxConns: 20
    architect-visibility:
      sql:
        driver: postgres12
        host: ${DB_HOST:-localhost}
        port: ${DB_PORT:-5432}
        database: ${DB_NAME:-architect_db}
        schemaName: architect_temporal_visibility
        user: ${DB_USER}
        password: ${DB_PASS}
        maxConns: 10
```

### Schema Creation (idempotent)

```bash
# Create schema (idempotent)
psql $DATABASE_URL -c "CREATE SCHEMA IF NOT EXISTS architect_temporal;"
psql $DATABASE_URL -c "CREATE SCHEMA IF NOT EXISTS architect_temporal_visibility;"

# Run Temporal schema migrations
temporal-sql-tool \
  --plugin postgres12 \
  --ep "$DB_HOST" \
  --db "$DB_NAME" \
  --schema-name architect_temporal \
  create-initial-schema

temporal-sql-tool \
  --plugin postgres12 \
  --ep "$DB_HOST" \
  --db "$DB_NAME" \
  --schema-name architect_temporal_visibility \
  setup-schema -v 1.0

# Register namespace
temporal operator namespace create architect \
  --retention 30d \
  --description "Architect SDLC project namespace"
```

### Namespace-per-Project Table

| Project | Namespace | Schema Pair |
|---------|-----------|-------------|
| ticari/architect/main | `architect` | `architect_temporal`, `architect_temporal_visibility` |
| (future project) | `<name>` | `<name>_temporal`, `<name>_temporal_visibility` |

The Temporal worker for each project specifies its namespace in the `WorkerOptions`. Workers for different projects can run as separate processes or separate task queues within the same process.

---

## 6. Chat UI Integration Surface

The chat frontend connects to Temporal at two points:

**Starting a session** (user logs in or opens new conversation):
```javascript
// API gateway handler
await temporalClient.start(userSessionWorkflow, {
  workflowId: `session-${conversationId}`,
  taskQueue: 'architect-sessions',
  args: [conversationId],
  workflowExecutionTimeout: '2h',
});
```

**Sending a message** (user submits chat input):
```javascript
await temporalClient.getHandle(`session-${conversationId}`)
  .signal(userMessageSignal, { text: userInput, messageId: crypto.randomUUID() });
```

**Escalation banner** (timeout_warning WebSocket event from W-1204):
- The `timeout_warning` event with `event: 'idle'` means the dispatch inside the current activity is idle.
- The chat UI renders an inline banner with "Extend" (calls `POST /api/dispatch/:id/extend`) and "Let it fail" options.
- This is wired at the dispatch level, not the Temporal level — the activity handles the extension internally.

**Human-in-the-loop approval** (Temporal signal flow):
```javascript
// User clicks "Approve" in chat UI
await temporalClient.getHandle(`session-${conversationId}`)
  .signal(approvalSignal, { approved: true });
```

**Reading conversation state** (for UI restoration on reload):
```javascript
const state = await temporalClient.getHandle(`session-${conversationId}`)
  .query('state');
// Returns: { messages: [...], currentActivity: 'dispatching', awaitingApproval: false }
```

---

## 7. Work Items

**Exploration phase (done)**:

| Ticket | Title | Priority | Status |
|--------|-------|----------|--------|
| W-1207 | ADR-001 Re-evaluation: Temporal as SDLC workflow coordination layer | medium | done |
| W-1210 | Temporal PostgreSQL setup: multi-namespace schema isolation per project | medium | done |
| W-1209 | Architecture: per-session Temporal orchestrator with RAG | high | done |
| W-1208 | Chat dashboard: Claude.ai-style UI on ai_chat schema with Temporal escalation | high | done |

**E-1179 Dual Dispatch Track (active)**:

| Ticket | Title | Priority | Status |
|--------|-------|----------|--------|
| W-1257 | [E-1179-A] New sdlcDispatchWorkflow with sentinel return + input signal | high | planned |
| W-1260 | [E-1179-B] TemporalDispatchService + Temporal branch in /api/dispatch | high | planned |
| W-1258 | [E-1179-C] Domain + DB migration: dispatch_track + workflow_run_id | high | planned |
| W-1261 | [E-1179-D] Dispatch modal UI: Temporal track radio option | high | planned |
| W-1262 | [E-1179-E] Temporal panel UI: state badges + Send Input form | high | planned |
| W-1263 | [E-1179-F] Notifications: state-transition alert on waiting_for_input | medium | planned |
| W-1259 | [E-1179-G] Dev startup script + TEMPORAL_MOCK mode | medium | planned |
| W-1306 | [E-1179-H] Temporal infrastructure cleanup: complete architect isolation | low | in-progress |

---

## 8. Local Development Quickstart

```bash
# 1. Start existing Postgres (already running via dashboard)
./tools/dashboard/dashctl.sh status

# 2. Create Temporal schemas (idempotent)
./tools/temporal/setup.sh

# 3. Start Temporal dev server
temporal server start-dev \
  --config tools/temporal/config/development.yaml \
  --namespace architect

# 4. Verify namespaces
temporal operator namespace list

# 5. Start the worker (TypeScript)
npm run worker --workspace tools/temporal

# 6. Open Temporal Web UI
open http://localhost:8233
```
