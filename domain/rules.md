# Domain Rules

Business rules, heuristics, and decision logic for the architect system. Agents and skills reference this file instead of embedding rules inline.

## Complexity Heuristics

| Level | Criteria |
|-------|----------|
| trivial | Single file, < 20 lines changed, no architectural impact |
| small | 1-3 files, well-scoped, follows existing patterns |
| medium | 4-10 files, new patterns or cross-cutting concerns |
| large | 10+ files, new subsystem, architectural decisions required |

## Workflow Selection

| Condition | Workflow |
|-----------|----------|
| Trivial tasks | direct — dispatch a single coder agent |
| Small features | sequential — scout → planner → coder → tester → reviewer |
| Full-stack work (independent frontend/backend/infra) | parallel-fan-out — split then converge at tester → reviewer |
| Medium/large features | plan-then-execute — planner decomposes, then dispatch coders per task |
| Bugfixes | investigate-then-fix — debugger/scout → coder → tester |
| Vague scope, large initiatives, build-vs-buy | strategic-evaluation — strategist evaluates first |

## Agent Inclusion Rules

| Agent | Include when |
|-------|-------------|
| scout | No portfolio entry or scout report exists for the target project |
| strategist | Large/vague/strategic requests, build-vs-buy decisions |
| planner | Medium+ complexity (skip for small/trivial) |
| tester | All code changes except trivial |
| reviewer | All code changes except trivial |
| security-auditor | Auth, secrets, input validation, or external data is involved |

## Agent Permission Model

| Category | Agents | Can modify code | Can write data |
|----------|--------|-----------------|----------------|
| Read-only | reviewer, security-auditor, performance, strategist, pm, scout, debugger, dependency-manager, documenter | No | No |
| Implementation | coder, coder-frontend, coder-backend, coder-mobile, coder-infra, ci-cd, api-designer | Yes | No |
| Data-write | tracker | No | Yes (`work/backlog.json` only) |

**Exception**: strategist can write decision docs to `docs/`.

## Clarification Triggers

Flag clarifications when:
- Request scope is ambiguous (could mean multiple things)
- No portfolio entry or scout report exists and the project is unfamiliar
- Security implications are unclear
- Target environment or deployment context is missing
- The request mixes multiple concerns that should be separate tasks

## Confidence Threshold

When PM's classification confidence is below **0.6**, always include clarifications in the dispatch plan.

## Work Item Rules

- PM suggests work items for **medium+ complexity** requests only
- Work items are created only after user confirmation
- IDs use sequential `W-XXX` format (zero-padded, never reused)
- Statuses: `open` → `in-progress` → `done` (or `blocked`, `cancelled`)
- Session log is append-only

## PM Dispatch Rules

**Invoke PM for**:
- Work requests involving multiple agents or unclear scope
- Requests where the right workflow pattern is not obvious
- Unfamiliar projects with no existing scout report

**Skip PM for**:
- Slash commands (`/review`, `/test`, `/deploy`, etc.) — execute the skill directly
- Direct questions about code or architecture — answer directly
- Trivial tasks (typo fix, single-line change) — dispatch directly
- Explicit agent invocations where the user names the agent
