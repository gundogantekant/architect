# Architect Chat

Standalone Next.js 14 chat application backed by AWS Cognito, Temporal, and PostgreSQL. Each conversation maps to a `userSessionWorkflow` in Temporal; messages become workflow signals; responses are polled and streamed to the UI via SSE.

## Local Dev Setup

**Prerequisites**: Node 18+, Docker (for PostgreSQL), `temporal` CLI.

```bash
# 1. Install dependencies
cd tools/chat
npm install

# 2. Configure environment
cp .env.local.example .env.local
# Fill in NEXT_PUBLIC_COGNITO_USER_POOL_ID and NEXT_PUBLIC_COGNITO_CLIENT_ID

# 3. Apply database migrations (runs migration 032 which creates the ai_chat schema)
cd ../dashboard && node server.mjs &   # starts dashboard and runs migrations

# 4. Start Temporal dev server
temporal server start-dev --namespace architect

# 5. Start the chat app
cd ../chat && npm run dev
# Runs at http://localhost:3778
```

## 1. How User Messages Become Temporal Signals

When a user sends a message, the API route:

1. Inserts the message row into `ai_chat.messages`
2. Sends a `user-message` signal to the workflow identified by `conversationId`

```typescript
// app/api/conversations/[id]/messages/route.ts
const messageId = uuidv4();
await query(`INSERT INTO messages ...`, [messageId, params.id, content]);
await sendUserMessage(params.id, { messageId, content });

// lib/temporal-client.ts
export async function sendUserMessage(conversationId: string, payload: UserMessagePayload) {
  const handle = client.workflow.getHandle(conversationId);
  await handle.signal('user-message', payload);   // SIGNAL_USER_MESSAGE constant
}
```

The workflow ID is the conversation UUID, so each conversation maps to exactly one workflow execution. The `userSessionWorkflow` receives the signal, processes it via Claude, writes the assistant message back to `ai_chat.messages`, and returns to `idle` state.

## 2. How to Add a New Skill as a Workflow

Skills map to new Temporal workflow types. Steps:

1. Define the workflow in `tools/temporal/workflows/` following the `UserSessionInput` pattern.
2. Register the workflow on the worker in `tools/temporal/worker.ts`.
3. Add a new constant in `lib/types.ts`:
   ```typescript
   export const WORKFLOW_TYPE_MY_SKILL = 'mySkillWorkflow';
   ```
4. Add a starter function in `lib/temporal-client.ts`:
   ```typescript
   export async function startMySkillWorkflow(id: string, args: MySkillInput) {
     const client = await getClient();
     await client.workflow.start(WORKFLOW_TYPE_MY_SKILL, {
       taskQueue: TEMPORAL_TASK_QUEUE,
       workflowId: id,
       args: [args],
     });
   }
   ```
5. Call the starter from the relevant API route.

## 3. How to Add a New Agent as an Activity

Activities are the building blocks that workflows call. Each agent (e.g. coder, reviewer) is an activity.

1. Create the activity in `tools/temporal/activities/`:
   ```typescript
   // tools/temporal/activities/my-agent.ts
   export async function runMyAgent(input: MyAgentInput): Promise<MyAgentOutput> {
     // spawn claude -p with the agent prompt
   }
   ```
2. Register it on the worker alongside existing activities in `tools/temporal/worker.ts`:
   ```typescript
   activities: { ...existingActivities, runMyAgent }
   ```
3. Call it from a workflow:
   ```typescript
   const result = await proxyActivities<typeof activities>({ startToCloseTimeout: '10m' })
     .runMyAgent(input);
   ```

The activity's output (e.g. assistant message text) should be written to `ai_chat.messages` so the chat UI can display it.

## 4. How to Read and Display Token Costs

Token costs are written to `ai_chat.token_usage` by the activity that calls Claude. The chat UI reads them lazily per message:

```typescript
// components/TokenCostBadge.tsx
useEffect(() => {
  fetch(`/api/messages/${messageId}/cost`)
    .then((r) => r.ok ? r.json() : null)
    .then((data) => { if (data) setCost(data); });
}, [messageId]);
```

The API route (`app/api/messages/[messageId]/cost/route.ts`) joins `token_usage → messages → conversations` and enforces ownership before returning `{ inputTokens, outputTokens, model, costUsd }`.

To display costs elsewhere (e.g. a monthly usage summary), query:
```sql
SELECT usage_month, SUM(cost_usd) AS total_cost
FROM ai_chat.token_usage
WHERE user_sub = $1
GROUP BY usage_month ORDER BY usage_month DESC;
```

## Architecture

```
Browser (Next.js 14)
  ├─ /chat                  Conversation list (GET /api/conversations)
  ├─ /chat/[id]             Active thread
  │    ├─ MessageThread     Renders messages, listens to SSE stream
  │    ├─ WorkflowStatusIndicator  Polls Temporal state via context
  │    ├─ ApprovalGate      Shows when sessionState = awaiting-approval
  │    └─ EscalationBanner  Shows on timeout_warning custom event
  └─ /login                 Amplify Authenticator (Cognito)

API Routes (Node.js runtime)
  ├─ POST /api/conversations         Create conversation + start Temporal workflow
  ├─ GET  /api/conversations         List user's conversations
  ├─ GET  /api/conversations/[id]    Conversation + messages
  ├─ POST /api/conversations/[id]/messages  Save message + signal workflow
  ├─ GET  /api/conversations/[id]/stream    SSE: polls Temporal state every 500ms
  ├─ POST /api/conversations/[id]/signal    approval / extend signals
  ├─ GET  /api/conversations/[id]/status    One-shot Temporal state query
  └─ GET  /api/messages/[id]/cost    Token usage for a single message

Temporal (localhost:7233, namespace: architect)
  └─ userSessionWorkflow (workflowId = conversationId)
       Receives: user-message signal, approval signal
       Exposes:  session-state query → SessionSnapshot

PostgreSQL (ai_chat schema, migration 032)
  └─ users, conversations, messages, token_usage
```

## E2E Tests

Tests are in `__tests__/e2e/` and use Playwright. They require a running app and live dependencies.

```bash
# Run all E2E tests
npx playwright test __tests__/e2e/

# Run with live Cognito credentials
E2E_COGNITO_USER=test@example.com E2E_COGNITO_PASS=TestPass1! npx playwright test
```
