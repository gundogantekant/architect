# Domain Rules

Business rules, heuristics, and decision logic for the architect system. Agents and skills reference this file instead of embedding rules inline.

## Terminology: Project Knowledge

| Term | Meaning |
|------|---------|
| "project files" / "project knowledge base" | Architect portfolio files about a project (`portfolio/<org>/<project>/`) |
| "target project source files" / "source code" | The actual code in the target repository |

- All project know-how is stored in and retrieved from the architect portfolio — never from the target project itself.
- When the user says "project files" or "project knowledge base", they mean the architect portfolio entries, not target repo source files.
- When loading context, prioritize architect-level portfolio data over target project introspection.

## Terminology: Work Items

| Term | Meaning |
|------|---------|
| "task" | A work item — used in the dashboard UI and casual conversation |
| "ticket" | Synonym for task/work item — used interchangeably |
| "work item" | The formal entity name (W-XXX) — used in domain schemas and API |

All three terms refer to the same entity. The dashboard UI uses "task" for brevity. Internal code and API paths use "work-items". The ID prefix remains `W-XXX`.

## Terminology: System Concepts

| Term | Meaning |
|------|---------|
| "skill" / "slash command" | The same concept — a user-invocable workflow. "Skill" is the internal/formal term; "slash command" (e.g., `/review`) is the user-facing shorthand. |
| "portfolio entry" / "component profile" | The same entity — a JSON file at `portfolio/<org>/<project>/<component>.json` describing a project component. "Portfolio entry" is the formal term. |
| "brief" | The structured project overview section within a portfolio entry (`brief.purpose`, `brief.domain`, `brief.users`). Not a general synonym for "summary". |

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

## Parallelization Rules

Two tasks are **independent** when ALL of the following hold:

| Criterion | Check |
|-----------|-------|
| No file overlap | Tasks do not create or modify any of the same files |
| No data dependency | Neither task's output is an input to the other |
| No shared state | Tasks do not mutate the same database table, API endpoint schema, or shared configuration |
| No ordering constraint | The correctness of either task does not depend on the other completing first |
| Separate work scope | Tasks target different modules, packages, or directories — or touch the same directory but provably disjoint files |

### Enforcement

| Actor | Obligation |
|-------|------------|
| Coordinator | Populate `parallel_with` on every DispatchPlan step that shares no dependencies with another step. An empty `parallel_with` array means "evaluated, has dependencies" — not "not considered". When the workflow is `plan-then-execute`, note that the planner will refine parallelization at the task level. |
| Planner | Group tasks into **parallel batches** — sets of tasks that satisfy all independence criteria. Include a `### Parallel Batches` section in every plan with more than one task. Tasks within a batch run concurrently; batches execute sequentially. |
| Orchestrator | When dispatching from a PM plan: launch all steps that share the same `parallel_with` group concurrently. When dispatching from a planner plan: launch all tasks within the same parallel batch concurrently. Wait for a batch to complete before starting the next. If the orchestrator identifies additional parallelization not marked by PM or planner, it should exploit it using the independence criteria above. |

### Required vs Optional

| Situation | Rule |
|-----------|------|
| Two or more implementation agents (coder-*) with no file or data overlap | **Required** — dispatch in parallel |
| Read-only agent alongside an implementation agent on a different task | **Required** — read-only agents never conflict |
| Two implementation agents touching the same module but different files | **Optional** — orchestrator may parallelize if confident in file-level isolation |
| Any uncertainty about shared state or file overlap | **Sequential** — default to sequential when independence is not provable |

### Scope

These rules apply to ALL workflow patterns, not only `parallel-fan-out`:
- **sequential**: Check whether any adjacent steps are actually independent and could overlap
- **plan-then-execute**: Planner must group tasks into parallel batches
- **parallel-fan-out**: Already parallel by design; rules ensure convergence steps (tester, reviewer) wait for all parallel work
- **investigate-then-fix**: Investigation is always sequential; fix + test may parallelize if targeting separate components. When investigation spans >2 files or >1 component, dispatch multiple read-only agents (scout, debugger, Explore) in parallel during the investigation phase.
- **Triage-guided dispatch**: Coordinator applies rules to the execution plan; orchestrator enforces them

## Agent Inclusion Rules

| Agent | Include when |
|-------|-------------|
| scout | No portfolio entry or scout report exists for the target project |
| strategist | Large/vague/strategic requests, build-vs-buy decisions |
| planner | Medium+ complexity (skip for small/trivial) |
| tester | All code changes except trivial |
| reviewer | All code changes except trivial |
| security-auditor | Auth, secrets, input validation, or external data is involved |
| browser | E2E tests, visual regression, bug reproduction in browser, or web automation tasks requested by the user |
| tech-reviewer-* | All plans from planner agent (medium+ complexity) and all non-trivial code changes. Dispatched as a context-filtered group (3–10 agents) in parallel per Review Board Rules |

## Agent Permission Model

| Category | Agents | Can modify code | Can write data | Can interact with web | Uses worktree |
|----------|--------|-----------------|----------------|-----------------------|---------------|
| Read-only | reviewer, security-auditor, performance, strategist, classifier, coordinator, findings-coordinator, scout, debugger, dependency-manager, tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-dx, tech-reviewer-ux, tech-reviewer-frontend, tech-reviewer-dba, tech-reviewer-pm, tech-reviewer-systems, tech-reviewer-iot, tech-reviewer-prod | No | No | No | No (main tree) |
| Interactive | browser | No | No | Yes | No |
| Interactive | discuss | No | No | No | No |
| Implementation | coder, coder-frontend, coder-backend, coder-mobile, coder-infra, ci-cd, api-designer, documenter, refactorer, git-ops | Yes | No | No | Yes (worktree) |
| Onboarding | profiler | No (writes only CLAUDE.md to target project) | No | No | No |
| Data-write | tracker | No | Yes (dashboard API for work items/epics; `work/epics/E-XXX/*.md`, `work/items/W-XXX/*.md` for artifacts) | No | No |

**Exception**: strategist can write decision docs to `docs/`.
**Exception**: profiler writes only `CLAUDE.md` to the target project during onboarding.

## Workable Item Rules

A work item's "workable" state is computed at render time — it is never stored.

| Condition | State | Visual |
|-----------|-------|--------|
| No dependencies, or all deps have status `done` | Workable | Normal row |
| Any dependency has status other than `done` | Blocked by deps | Orange left border, tinted background |

Rules:
- Workable state is purely visual — it does not affect dispatching or status changes
- When a dependency's status changes, all dependents re-evaluate on next render
- The dispatch button remains available regardless of workable state

## Model Affinity Rules

Certain tool categories perform best on specific models. The orchestrator enforces these before direct tool use in the main session.

| Tool Category | Preferred Model | Reason |
|---------------|-----------------|--------|
| Playwright MCP (browser_*) | sonnet | Cost-efficient for interactive browser work |

**Enforcement protocol** (main session only — subagent dispatch handles this automatically):
1. Before the first Playwright MCP tool call in a session, check the active model
2. If the active model is not the preferred model, ask the user: "Playwright tasks run best on sonnet. Switch to sonnet with /model sonnet? (Current: {model})"
3. Record the previous model
4. After the Playwright task sequence completes, ask the user: "Playwright work is done. Switch back to {previous model} with /model {previous model}?"
5. If the user declines either prompt, proceed without switching

## Target Project Identification

Every action on a target project — whether a plan, an agent dispatch, or a skill
invocation — must be preceded by resolving the target project using all five fields
below. The orchestrator is responsible for this resolution before any work begins.

Format:
- **Organization**: org name from portfolio (or `–` if not onboarded)
- **Project**: project name from portfolio (or directory basename if not onboarded)
- **Component**: component name from portfolio (or `–` if single-component)
- **Path**: absolute filesystem path to the project root
- **Branch**: result of `git rev-parse --abbrev-ref HEAD` at the target path; append `, worktree` if the target is a git worktree (detected when `git rev-parse --git-common-dir` does not resolve to `<target-path>/.git`)

Detection steps:
1. Run `git rev-parse --abbrev-ref HEAD` at the target path for Branch
2. Run `git rev-parse --git-common-dir` to detect worktree status
3. Look up the absolute path in `portfolio/registry.json` to resolve Organization, Project, and Component
4. If not found in registry: Organization=`–`, Project=directory basename, Component=`–`

Examples:
- Organization: gundogantekant
  Project: my-app
  Component: backend
  Path: /Users/user/projects/my-app/backend
  Branch: main

- Organization: gundogantekant
  Project: my-app
  Component: frontend
  Path: /Users/user/projects/my-app-frontend-GEN-1234-auth-flow
  Branch: my-app-frontend-GEN-1234-auth-flow, worktree

- Organization: –
  Project: scratch
  Component: –
  Path: /Users/user/projects/scratch
  Branch: develop

- Organization: –
  Project: architect
  Component: –
  Path: /Users/user/Documents/architect
  Branch: feat/plan-metadata

### Missing Target Fields

If the orchestrator or user request does not provide enough information to populate all
five fields, the orchestrator, planner, or PM MUST request the missing information before
proceeding. They must not guess or leave fields blank — the only
exception is the documented defaults for non-onboarded projects (Organization=`–`,
Component=`–`, Project=directory basename), which require at minimum the absolute path.

### Orchestrator Resolution Rule

The orchestrator (main Claude session) must resolve the target project's five fields
before dispatching any agent or executing any skill. Resolution sources, in priority order:

1. Explicit user statement (e.g., "work on /Users/user/projects/my-app")
2. Active conversation context (project was already identified earlier in the session)
3. Current working directory (cwd) — only if the user's request clearly targets the cwd project

If none of these provide a clear target, the orchestrator must ask the user which project
they intend to work on before proceeding. This applies to all modes: plan mode, PM dispatch,
direct agent invocation, slash commands, and trivial tasks.

### Plan File Requirement

When the orchestrator operates in plan mode and produces a plan file, the plan must
include a **Target Project** section containing all five fields. This section must appear
near the top of the plan (immediately after any Context/summary section). Plans that
omit the target project section are incomplete and must not proceed to execution.

For architect self-changes, use the standard self-reference:
Organization=ticari, Project=architect, Component=main.

### Organization Awareness

- **Org Context Propagation**: Every agent dispatch targeting a portfolio project must include org name and org conventions (from `portfolio/<org>/organization.json`) in the agent prompt
- **Cross-Org Operations**: When a task or epic spans multiple orgs, the orchestrator must explicitly note this. Agents must not assume one org's conventions apply to another. Epics may span orgs; work items belong to exactly one org via their project key
- **Case Normalization**: Org names in project keys are always lowercase. Tracker must lowercase the org portion when creating new project key entries
- **Convention Precedence**: Agents must apply org-level conventions (branch prefix, PR title pattern) as baseline defaults. Org-level rules act as constraints alongside project-level guidance. When org conventions conflict with project conventions, project conventions take precedence

### Portfolio-Aware Disambiguation

When the user references a project by name (not an absolute path), the orchestrator must
attempt to match against the portfolio before asking the user.

**Algorithm**:
1. Read `portfolio/registry.json` and collect all entries
2. Normalize user input: lowercase, collapse hyphens/underscores/spaces to a single space
3. For each registry entry, build matchable strings using the same normalization:
   `project` field, `component` field, path basename, `org` field
4. Substring match in both directions (user input ⊂ candidate OR candidate ⊂ user input),
   case-insensitive

**Resolution**:
- **1 match** → auto-resolve: populate all five target fields from the registry entry + git detection
- **Multiple matches** → present only matched candidates as `org/project/component (path)`, ask user to pick
- **No matches, registry non-empty** → list all registered projects as `org/project/component (path)` + offer "Other (provide path)"
- **Registry empty or missing** → ask user for the absolute path (current behavior)

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
- New items default to status `draft`
- Statuses: `draft` → `planned` → `in-progress` → `done` (or `blocked`, `cancelled`); see State Transition Table for full map
- `archived` is reachable only from `done` or `cancelled` — archived items are hidden from the active backlog
- **Contract-gated planned transition**: The `draft → planned` transition requires a valid contract. At minimum, a non-empty `goal` field must be present (from structured description sections, coordinator DispatchPlan, or manual input). For medium+ complexity: all 4 core contract fields must be populated. For large complexity: `scope_boundary` and `stop_conditions` (3+) must also be populated. The plan gate (Review Board) evaluates the contract alongside the plan for medium+ complexity. Dashboard dispatch is restricted to `planned`+ status items.
- Session log is append-only
- `list` supports `--org <name>` to filter by organization prefix
- `list` supports `--project` with comma-separated values for multi-project filtering
- `--org` and `--project` can be combined: org narrows first, project filters within

### State Transition Table

Canonical source for state transitions. `tools/dashboard/constants.mjs` mirrors this table via `VALID_TRANSITIONS`. A contract test enforces consistency.

| From | Valid Targets |
|------|---------------|
| `draft` | `planned`, `cancelled` |
| `planned` | `in-progress`, `draft`, `cancelled` |
| `in-progress` | `blocked`, `in-review`, `cancelled` |
| `blocked` | `in-progress`, `cancelled` |
| `in-review` | `in-progress`, `testing`, `cancelled` |
| `testing` | `in-progress`, `preview`, `cancelled` |
| `preview` | `in-progress`, `done`, `cancelled` |
| `done` | `archived`, `cancelled` |
| `cancelled` | `draft`, `archived` |
| `archived` | — (terminal) |

Backward transitions (returning to an earlier phase): `in-review → in-progress`, `testing → in-progress`, `preview → in-progress`, `blocked → in-progress`, `cancelled → draft`.

### Flag Blocking Rule

Forward transitions are rejected when `input_needed = 1` OR `approval.active = 1`. The following administrative transitions bypass flag blocking and are always allowed:
- Backward transitions (see above)
- Any state → `cancelled`
- Any state → `archived`

### Draft → Planned Contract Gate (W-236 preserved)

`draft → planned` requires a valid DispatchContract attached to the work item:
- Minimum (any complexity): non-empty `goal`
- Medium+: all four core fields (`goal`, `constraints`, `expected_output`, `failure_conditions`)
- Large: also `scope_boundary` and `stop_conditions` (3+ entries)

The contract gate operates independently of the `approval` flag — both must be satisfied when approval is required.

### T1 Fast Path

Items tagged `T1` (trivial complexity) may skip `in-review`, `testing`, and `preview` via the shortcut trajectory `draft → planned → in-progress → done`. This path is valid ONLY for items whose `tags` array contains `T1`. The `in-progress → done` shortcut is rejected for untagged items. Medium+ items walk the full pipeline.

### Planned → Draft Rollback

Rolling a `planned` item back to `draft` (contract invalidation) requires a mandatory `reason` field in the PATCH payload. The reason is appended to `session_log` with a timestamp. The API rejects the transition with HTTP 400 when the reason is missing.

### Sequential Approval Semantics

When a work item's `approval.mode = 'sequential'`:
- Only the approver with the lowest `sort_order` whose status is `pending` is currently active
- On that approver's decision, the next-highest pending approver becomes active
- When all approvers have approved (or the resolution criterion is met), `approval.active` flips to 0 and `approval.resolved_at` is set

In `all` mode, every approver must approve. In `any` mode, the first approval resolves the flag.

### Invalid Transition Error Shape

API responses for invalid transitions include the valid target list:

```json
{
  "error": "invalid transition draft→in-progress",
  "from": "draft",
  "attempted": "in-progress",
  "valid_targets": ["planned", "cancelled"]
}
```

### Stakeholder Projection

Simplified status rendering for non-technical consumers (CLI, Telegram, Chat). The dashboard API exposes `?view=stakeholder` to return projected statuses.

| Internal States | Stakeholder View |
|-----------------|------------------|
| `draft`, `planned` | Requested |
| `in-progress`, `blocked` | In Progress |
| `in-review`, `testing`, `preview` | In Review |
| `done` | Done |
| `cancelled` | Cancelled |
| `archived` | Archived |

Flag modifiers still render: `In Progress [input needed]`, `In Review [approval needed]`.

## Epic Rules

- Epics use `E-XXX` IDs (zero-padded, globally unique, never reused)
- One epic per work item maximum
- `project_keys` is auto-derived when items are linked/unlinked — never set manually
- Status transitions: `draft → active → done` (or `cancelled` from any state, `archived` from `done` or `cancelled`)
- Tracker agent suggests status transitions but does not auto-change them
- Epic docs stored at `work/epics/E-XXX/` (plan.md, docs.md) — created lazily
- Work item artifacts stored at `work/items/W-XXX/` (plan.md, docs.md) — created lazily. The `notes` field on WorkItem is deprecated; use file artifacts instead

## Dependency Rules

- `depends_on` is always an array (empty `[]` = no dependencies)
- Cross-project dependencies are allowed — IDs are globally unique
- Circular dependencies are forbidden: before adding A depends on B, DFS from B through `depends_on` edges; if A is reachable, reject the dependency
- Tracker suggests `blocked` status when unfinished dependencies exist, but does not auto-change status
- Topological sort (Kahn's algorithm) for display: roots first (no deps), then items whose deps are all listed; within same level, sort by priority desc then ID asc; items with external deps (outside filtered set) appended at end

## Triage Dispatch Rules

The orchestrator uses a two-stage triage flow: **classifier** (haiku, fast) then optionally **coordinator** (sonnet, detailed).

**Invoke classifier for**:
- Work requests involving multiple agents or unclear scope
- Requests where the right workflow pattern is not obvious
- Unfamiliar projects with no existing scout report

**Invoke coordinator after classifier when**:
- Classifier returns `needs_coordinator: true`
- Complexity is medium or higher
- Classifier confidence is below 0.6
- Workflow requires parallelization planning

**Skip triage entirely for**:
- Slash commands (`/review`, `/test`, `/deploy`, etc.) — execute the skill directly
- Direct questions about code or architecture — answer directly
- Trivial tasks (typo fix, single-line change) — dispatch directly
- Explicit agent invocations where the user names the agent

## Pre-Dispatch Check Rules

Before dispatching work agents, the orchestrator checks whether the user's request overlaps with recent codebase changes, done/in-progress work items, or active dispatches. This catches human errors where the user's mental model is stale — requesting changes that already exist or conflict with ongoing work.

### Trigger Condition

The orchestrator runs the pre-dispatch check when the classifier returns:
- `classification.type` is one of: `feature`, `bugfix`, `refactor`, `maintenance`
- AND `classification.complexity` is `small` or higher

No classifier schema change is needed — the orchestrator derives the trigger from existing ClassifierOutput fields.

### Skip Conditions

The pre-dispatch check does NOT run when:
- Classifier gates it: type is NOT in {feature, bugfix, refactor, maintenance} OR complexity is `trivial`
- Slash commands: handled before classifier runs
- Target project is not in portfolio: no backlog to check against
- Explicit work item reference: user references a specific work item ID (e.g., "continue W-891") — they are already aware of context

### Checks

| Check | Method | Flags |
|-------|--------|-------|
| Already Done | `git log --oneline -20 --grep=<term> -i` + `GET /api/work-items/search?q=<terms>&project_key=<key>` filtered locally to `status=done` | Commit messages or done work items matching keywords |
| Open Items Overlap | `GET /api/work-items/search?q=<terms>&project_key=<key>` (returns non-terminal items only) + `GET /api/dispatch/active` | Items in any non-terminal status (draft, planned, in-progress, blocked, in-review, testing, preview) that overlap the request |
| Recent Changes Staleness | `git log --oneline -5 -- <path>` (when the request mentions specific files or modules) | Recent commits touching the same area the request targets |

### Keyword Extraction

The orchestrator extracts 2–5 significant terms from the user's request:
- Entity names (nouns describing the thing being changed)
- Action verbs (add, remove, fix, implement, refactor)
- File or module names explicitly mentioned

Example: "add dark mode toggle to settings" → terms: `dark-mode`, `toggle`, `settings`

### Severity Scoring

| Condition | Severity |
|-----------|----------|
| 1 keyword match in git log or done item title | `minor` |
| 1+ keyword match on a draft or planned item | `major` |
| 2+ keyword matches across git log and/or open backlog | `major` |
| Exact title match on any open (non-terminal) item | `critical` |
| Active dispatch whose item title matches 2+ keywords | `critical` |

### Orchestrator Behavior on Findings

| Status | Behavior |
|--------|----------|
| `clear` | Proceed silently. Do not mention the check to the user. |
| `warning` (all minor) | Mention findings briefly, proceed without blocking. |
| `warning` (any major on open item) | Present the matching item: "I found an existing tracked item: **W-XXX — [title]** (status: planned). Should I dispatch on that item instead?" Block until user confirms yes or no. |
| `conflict` (any critical) | Present findings, strongly recommend reviewing evidence before proceeding. User can override. |

### Haiku Semantic Disambiguation

When keyword search returns exactly 1 candidate with a score of 1 (single weak hit) AND the request is abstract or generic (no specific file or component names mentioned), the orchestrator may present the candidate for user confirmation before deciding to proceed or reuse the existing item.

- **Condition**: 1 result, score = 1, request contains no file or module names
- **Action**: Present the candidate title and ask: "This may relate to **W-XXX — [title]**. Are these the same topic?"
- **Fallback**: If user says no or does not respond — proceed with original flow
- **Skip when**: 0 candidates; exact title match (score ≥ 2 or title overlap is unambiguous); request is specific (file or component names present)

### Presentation Format

When findings exist, the orchestrator presents them as:

```
**Pre-dispatch check** — I found related recent activity:

- [type] severity: summary (evidence)
  → recommendation

Proceed with this request?
```

Findings are listed by severity (critical first), max 5 shown. If more exist, append: "(+N more findings)".

### Parallelization

When both the pre-dispatch check and the coordinator are needed (`needs_coordinator: true`), the orchestrator runs the pre-dispatch check in parallel with the coordinator dispatch — they are independent operations. If the check requires user confirmation, the coordinator output is buffered until the user confirms.

## Coding Standards

Shared standards enforced by all implementation agents. These rules apply to every line of code written by the system.

### Clean Code
- **Names reveal intent**: `userCount` not `n`, `isAuthenticated` not `flag`, `fetchOrderHistory()` not `getData()`, `filteredActiveUsers` not `rows`
- **Self-explanatory code**: No comments except `TODO` and `DECISION` tags. If code needs a comment to be understood, rename or restructure it.
- **No dead code**: Never commit commented-out code, unused imports, or unreachable branches. Delete rather than comment.
- **Short, single-purpose functions**: One function does one thing. If a function description has "and", split it. ~20 lines max as a guideline.
- **Prefer editing existing files**: Add to existing modules before creating new files. New files are justified only for genuinely new concepts.
- **No over-engineering**: No abstractions without two concrete use cases. No factory-of-factory patterns. No premature generalization.

### Clean Architecture
- **Dependencies point inward**: domain ← usecases ← adapters ← infrastructure. Never import from an outer layer into an inner one.
  - Do: `usecases/createOrder.ts` imports `domain/Order.ts`
  - Don't: `domain/Order.ts` imports `infrastructure/database.ts`
- **Separate business logic from I/O**: Business rules must not contain HTTP calls, file reads, database queries, or UI rendering. Inject dependencies or use ports/adapters.
- **Domain owns types**: Define types, enums, state values, and schemas in the domain layer. All other layers import from domain — never redefine.
- **Integrate through existing interfaces**: New code connects via existing APIs, hooks, or extension points. Do not bypass layers or create parallel paths.

### DRY
- **Check before defining**: Before creating a type, enum, constant, or utility, search the project's domain layer and shared definitions. Import if it exists.
- **Three occurrences = extract**: The first duplication is noted, the second triggers extraction into a shared utility.
- **Single source of truth**: If a value is defined in one place, every consumer imports it. Never redefine, copy-paste, or hardcode the same value elsewhere.

### General
- Avoid OWASP Top 10 vulnerabilities (injection, XSS, broken auth, etc.)
- Consider Linux compatibility for all file paths and shell commands

### Coding Standards Brief

The following block is the compact form of the above standards. It is embedded directly in agent prompts and dispatch contexts so that sub-agents receive actionable standards without needing to read this file.

```
CODING STANDARDS — apply to all code you write:
- Names reveal intent: `userCount` not `n`, `isAuthenticated` not `flag`, `fetchOrderHistory()` not `getData()`
- No comments except TODO/DECISION tags — if code needs a comment, rename or restructure
- No dead code: no commented-out code, no unused imports, no unreachable branches
- Functions: single-purpose, ~20 lines max. If description has "and", split it
- Dependencies point inward: domain ← usecases ← adapters ← infrastructure. Never import outward.
- Business logic must not contain I/O (HTTP, DB, file, UI). Use dependency injection or ports/adapters.
- Domain layer owns all types, enums, state values. Other layers import — never redefine.
- Before creating any type/enum/constant, search the domain layer first. Import if it exists.
- Three occurrences = extract to shared utility. Single source of truth — never redefine values.
- No over-engineering: no abstractions without two concrete use cases.
- Integrate through existing interfaces — do not bypass layers or create parallel paths.
- Avoid OWASP Top 10 vulnerabilities. Consider Linux compatibility.
```

## Domain-First Rule

Before implementing any type, enum, state value, or schema:
1. Check `domain/entities.md` (for architect itself) or the target project's domain layer for an existing canonical definition
2. If one exists, import or reference it — do not redefine
3. If none exists and the concept is shared across layers, define it in the domain layer first, then reference it from implementation code

This applies to all implementation agents and the planner.

## Agent Dispatch Standards

When dispatching any agent via the Agent tool, the orchestrator MUST structure the dispatch prompt using the template below. This applies to:
- Main session dispatching sub-agents
- Dashboard-dispatched orchestrators dispatching their own sub-agents
- Any agent that has the ability to spawn sub-agents

Sub-agents receive their context exclusively from (a) their agent `.md` file and (b) the prompt parameter. File read instructions ("See domain/rules.md") are unreliable because agents may not follow through under turn pressure. The inline template ensures context is present regardless.

### Dispatch Prompt Template

Every Agent tool dispatch prompt MUST include these sections. Use the labelled placeholders as a fill-in template — empty or missing sections indicate an incomplete dispatch.

```
## Task
[What the agent should do. Expected output format. Success criteria.]

## Target Project
[Organization, Project, Component, Path, Branch — all five fields.]

## Project Context
[Tier-filtered portfolio context. Look up the agent in § Context Tier Mapping
to determine which fields to include. Omit for architect-internal tasks.]

## Coding Standards Brief
[Include the compact coding standards block from § Coding Standards Brief.]

## Constraints
[Relevant rules, scope boundaries, what NOT to do. Include org conventions.]
```

**Conditional sections** (include when applicable):
- `## Work Item` — when the dispatch is for a tracked work item (ID, title, description, status)
- `## Epic Context` — when the work item is linked to an epic (title, acceptance criteria, progress)
- `## Environment` — when the agent needs dashboard API endpoints or path information

**Exemptions**:
- Read-only agents at `none` tier (git-ops): only Task and Target Project sections are required
- Architect-internal tasks (no portfolio project): omit Project Context section
- Trivial dispatches matching the Trivial Exception Rule: exempt from template (but these should be handled inline, not dispatched)

## Dispatch Contract Rules

Every dispatch step for medium+ complexity work must carry a DispatchContract (see `domain/entities.md`) that defines clear success criteria. This ensures agents have unambiguous goals to work against and enables structured evaluation of dispatch outcomes.

### When Required

| Complexity | Contract Required |
|------------|-------------------|
| trivial | No — `purpose` field suffices |
| small | No — `purpose` field suffices |
| medium | Yes — all four core fields must be populated |
| large | Yes — all four core fields must be populated |

### Complexity-Scaled Contract Detail

| Complexity | Core Fields (4) | scope_boundary | stop_conditions | success_criteria | e2e_test_criteria |
|------------|-----------------|----------------|-----------------|-----------------|-------------------|
| trivial | None | None | None | None | None |
| small | None | None | None | None | None |
| medium | Required, 1-2 sentences each | Optional | Optional | Required | Required |
| large | Required, 2-3 sentences with measurable criteria | Required | Required (3+) | Required | Required (3+) |

### Who Produces

- **Coordinator**: Produces contracts as part of the DispatchPlan for medium+ complexity work. Each step in `execution_plan.steps` includes a `contract` field.
- **Orchestrator**: For direct dispatches without a coordinator (e.g., orchestrator constructs plan from classifier output for medium+ work), the orchestrator constructs a minimal contract from the work item description.

### Contract Source

The coordinator derives contracts from:
1. Work item description — if it already contains Goal/Constraints/Expected Output/Failure Conditions sections, extract and formalize them
2. Epic context — acceptance criteria and plan excerpts inform goal and constraints
3. Portfolio context — project conventions and custom rules inform constraints

### Propagation

- The prompt-builder renders the contract as a `# Dispatch Contract` section in the dispatch prompt
- Sub-agent dispatches from the orchestrator session include the relevant step's contract in the agent prompt
- One contract per dispatch step, not per work item — a multi-step plan has one contract per step

### Field Guidance

Each field should be 1–3 sentences. Avoid duplicating information already present in the work item description. The contract captures what the work item description does not make explicit: precise success criteria, hard limits, expected deliverable shape, and rejection criteria.

### Empty String Policy

Empty strings are treated as absent. The prompt-builder strips empty fields and renders only populated ones. A contract with all four fields empty is equivalent to no contract.

### Backward Compatibility

Steps without a `contract` field (from pre-existing plans or trivial/small dispatches) remain valid. The prompt-builder gracefully no-ops when the contract is missing or incomplete. No migration is needed for existing DispatchPlans.

### Refine Dispatch (AI Orchestrator Guidance)

Guidance for AI orchestrators only. Not enforced server-side — human operators using the dashboard dispatch freely via standard `/api/dispatch` regardless of work item status.

- When a work item is in `draft` status, AI orchestrators run a refine pass before any full implementation dispatch.
- Refine pass: analyze the work item title and description, propose values for the four core DispatchContract fields (goal, constraints, expected_output, failure_conditions), then `PATCH /api/work-items/<id>` with the contract payload and `status: 'planned'`.
- Full implementation dispatch is initiated only after the item reaches `planned`+ with a non-empty `goal`.
- The auto-implement endpoint enforces this gate at the API boundary (see Auto-Implement Eligibility Rules below) — the standard dispatch endpoint does not.

## Auto-Implement Eligibility Rules

Checked before creating an auto-implement dispatch. All conditions must pass; any failure returns 400 with a user-facing reason string.

| Condition | Required | Rejection Message |
|-----------|----------|-------------------|
| Work item status is `planned` or `in-progress` | Yes | "Work item status '<status>' cannot be auto-implemented. Must be planned, in-progress." |
| All `depends_on` items have status `done` | Yes | "Unmet dependencies: <id1>, <id2>. Resolve these before auto-implementing." |
| No active dispatch exists for this work_item_id | Yes | "A dispatch is already running for this work item." |
| Caller session depth must be 0 | Yes | "Auto-implement cannot be triggered from within a dispatch agent (depth ≥ 1)." |

Depth is communicated via `X-Architect-Session-Depth` request header. When absent, depth is assumed to be 0 (preserves CLI and browser flows). When present and ≥ 1, reject with 403.

### Auto-Implement Eligible Statuses

Canonical list of statuses eligible for the auto-implement endpoint. `constants.mjs` mirrors this table via `AUTO_IMPLEMENTABLE_STATUSES`. A contract test enforces consistency.

| Status |
|--------|
| `planned` |
| `in-progress` |

### Agent Completion Signal Obligation

- After step 12 (commit) completes, the agent MUST call `POST /api/dispatch/:id/complete` and then halt. Steps 13–16 of implement-work-item.md are handled server-side by the autonomous pipeline.

## Auto-Implement Failure Protocol

When the autonomous agent encounters a blocking failure (no user present to decide):

| Failure Event | Agent Action |
|---------------|-------------|
| Plan Gate blocked after 2 TRB revision cycles | Log block reason to work item session log; halt; dispatch status = 'failed' |
| Tests fail after 2 coder-fix iterations | Log failure details; halt; preserve worktree |
| Code Gate blocked after 2 revision cycles | Log block reason; halt; preserve worktree |
| Commit failure | Log error; halt; preserve worktree |

In all failure cases: dispatch status = 'failed', work item status remains 'in-progress'. User reviews via dashboard and decides next step (retry, fix manually, or discard worktree).

## Autonomous Pipeline Rules

These rules govern the completion signal, pre-merge gate, server-side merge, and cleanup for `auto_implement` dispatches.

### Completion Signal

- The agent MUST call `POST /api/dispatch/:id/complete` (with `X-Architect-Session-Depth: 1` header) after committing. This is the authoritative completion signal.
- Process exit code 0 WITHOUT a prior POST /complete → dispatch transitions to `completed` (not `merge_pending`) with a UI badge "agent exited without completion signal". No merge is triggered.
- The endpoint is agent-only (depth ≥ 1). The pre-merge trigger `/merge` is UI/human-only (depth === 0).

### New Dispatch Statuses

- `merge_pending` — agent signalled completion, pre-merge gate is active; WorkItem remains `in-progress`
- `merge_conflict` — merge was attempted but produced a git conflict; worktree is preserved intact
- Both statuses are set on `DispatchRequest`, NOT on `WorkItem`. WorkItem is only set to `done` after a successful merge.

### Pre-Merge Gate

Controlled by `DashboardPreferences.merge_gate`:
- `confirm` (default) — human approves merge in dashboard UI by clicking "Merge Now"
- `auto` — server merges after a 10-second delay on initial signal; on server restart recovery, merge triggers immediately (no delay)

### Merge Lock

- Server holds an in-memory `Map<dispatch_id, boolean>` lock for concurrent-merge protection
- Lock acquired synchronously before any `await` in the merge code path
- Lock released in a `finally` block unconditionally

### Mid-Merge Crash Recovery

- `attemptMerge` checks for `.git/MERGE_HEAD` at the project path at the start of every invocation
- If found: runs `git merge --abort` to reset the partial merge, then re-attempts
- This makes `attemptMerge` idempotent on restart

### Cancel

- `POST /api/dispatch/:id/merge/cancel` clears any pending auto-merge timer
- Dispatch remains in `merge_pending` — user can still trigger merge manually via `POST /api/dispatch/:id/merge`
- This is a distinct endpoint — never reuse `DELETE /api/dispatch/:id` for cancel

### Session Depth Guards

- `POST /api/dispatch/:id/complete` — requires `X-Architect-Session-Depth >= 1` (agent-only)
- `POST /api/dispatch/:id/merge` — requires depth `=== 0` (UI/human-only)

### Worktree Cleanup

- On successful merge: worktree directory removed (`git worktree remove --force`), branch deleted (`git branch -d`), dispatch transitions to `completed`, work item to `done`
- On conflict (`merge_conflict`): worktree is preserved intact for manual resolution. User may run `/pr` to push the branch and open a PR instead.

### No Automatic Retry

On merge failure, dispatch enters `merge_conflict`. No automatic retry. User decides next action.

### Contract Derivation from Work Item Description

When no explicit contract is provided and the work item description contains structured sections, the prompt-builder extracts contract fields automatically. Recognized section headers (markdown bold format):

- `**Goal**:` → goal
- `**Constraints**:` → constraints
- `**Expected Output**:` → expected_output
- `**Failure Conditions**:` → failure_conditions
- `**Scope Boundary**:` → scope_boundary
- `**Stop Conditions**:` → stop_conditions (newline-separated items become array entries)
- `**Success Criteria**:` → success_criteria
- `**E2E Test Criteria**:` → e2e_test_criteria (newline-separated items become array entries)

Only fields with matching headers are populated. Free-form descriptions without these sections produce no derived contract. Explicitly provided contracts (via dispatch modal or coordinator) take precedence over derived contracts.

## Long-Running Session Rules

Dispatched agents on medium+ complexity work must follow phase-based progress reporting and self-enforcement of scope and stop conditions. These rules are prompt-level advisory guidance — the agent self-regulates based on its contract.

### Phase-Based Progress Checkpoints

Agents must log progress via `POST /api/work-items/<id>/log` at these phases:

1. **Post-investigation**: After reading relevant files and before planning changes — log: files examined, approach decided, estimated scope
2. **Post-implementation-batch**: After each logical group of file changes — log: files modified, what was done, remaining work
3. **Pre-stop-condition**: Before stopping due to a stop condition — log: trigger condition, work accomplished, recommendation
4. **Completion**: On task completion — log: summary of all changes, test results, branch name

### Scope Boundary Self-Enforcement

When `scope_boundary` is present in the contract:

1. Before modifying any file, the agent checks the path against the stated boundary
2. Out-of-scope discoveries are logged as new work items via the dashboard API
3. The agent does NOT expand into out-of-scope areas

This is advisory prompt guidance. Post-dispatch scope verification (comparing worktree diff against declared scope_boundary) is a separate capability not covered here.

### Stop Condition Protocol

When a `stop_conditions` entry matches the current situation:

1. Agent stops implementation immediately
2. Agent logs the condition via the work item session log
3. Agent produces a structured summary: what was accomplished, what triggered the stop, what it recommends
4. Agent does NOT continue past the stop point

Stop conditions complement (not replace) orchestrator-level escalation triggers (stale, blocked-chain, epic-stall, cost-anomaly, dispatch-loop defined in PM Behavior Rules). Stop conditions are agent-self-enforced during execution; orchestrator triggers are detected after execution.

## Git Standards

Shared git rules enforced by all implementation agents.

- Never push to main; create feature or fix branches for all changes
- Commit only relevant changed files at the end of implementation
- Exclude Claude attribution from commit messages
- Never use --no-verify flag
- Avoid amending commits; prefer new commits

## Worktree Rules

- **All work on portfolio projects MUST use a worktree by default, unless the PortfolioEntry sets `worktree_mode: "explicit"` or `"none"`.** This applies to implementation agents, direct orchestrator edits, and any skill that modifies code in a portfolio project. When `worktree_mode` is `"explicit"`, agents work in-place on the current branch and only create a worktree when the user explicitly requests one. When `worktree_mode` is `"none"`, no worktree is ever created — all work is in-place. When `worktree_mode` is `"auto"` (the default), the only exception is when the user explicitly requests working without a worktree (e.g., "edit in place", "no worktree", "work on main").
- **Dispatch infrastructure creates worktrees for `acceptEdits` mode dispatches with a work item** when `worktree_mode` is `"auto"` and the `worktree_at_dispatch` preference is enabled. The dispatched agent starts with `cwd` already set to the worktree. Agents detect this via the `# Worktree Context` section in their prompt and skip their own worktree creation step (implement-work-item step 8).
- **`plan` mode dispatches, ad-hoc dispatches (no work item), and `worktree_mode: "explicit"` projects** do not get dispatch-level worktrees. The agent manages its own worktree if needed.
- **`worktree_mode: "none"`** is used for non-git projects. Set automatically by the profiler when `git rev-parse --git-dir` fails at the project root. Dispatch proceeds in-place with no isolation. No worktree is ever created, regardless of permission mode, work item presence, or feature flag.
- **Worktree creation failure blocks the dispatch** with a 500 error. There is no silent fallback to the original project directory — isolation is mandatory when requested.
- Read-only operations (review, audit, diagnosis, scouting) do not require a worktree.
- Worktrees are sibling directories of the project folder, not inside it
- Path: `<parent-of-project-dir>/W-<id>/` (e.g., `/Users/user/NeuronicRepos/W-933/`)
- Branch/folder naming: `W-<id>` (e.g., `W-933`). Both the worktree directory and branch name use this form — short, ticket-centric, immediately identifiable.
- Ticket ID comes from the work item ID (W-XXX); the orchestrator obtains it before creating the worktree
- WorktreeContext captures `originating_branch` at creation time — the branch the worktree was branched from. This may be `main`, a feature branch, or any other branch.
- After worktree creation, `worktree_setup` hooks from the PortfolioEntry run if defined (copy paths, post commands)
- After implementation completes (tests pass, commit made): present a pre-merge confirmation showing the branch, target, and commit count, then automatically merge-back into the originating branch and remove the worktree. On conflict: first dispatch the coder agent to attempt auto-resolution with impact analysis — if the resolution is clean and low-risk, apply it and continue the merge; if the conflict cannot be resolved meaningfully, abort the merge, preserve the worktree intact, list conflicting files, and offer two paths: run `/pr` to push a pull request instead, or leave the worktree open for manual resolution. Do not set the work item to `done` until after a successful merge. PR creation is not automatic — the user invokes `/pr` explicitly when a GitHub PR is wanted.
- The user may still invoke `/worktree cleanup` to discard the worktree at any point.
- **Merge-back** uses fast-forward when possible, falls back to merge commit. On conflict: attempt auto-resolution with coder agent + impact analysis before reporting to user.
- Portfolio registry always stores the original project path, never worktree paths

### Pre-Dispatch Worktree Readiness Check

Before dispatching any implementation agent to a `worktree_mode: "auto"` project with a work item ID, the orchestrator must verify worktree readiness using only the already-loaded PortfolioEntry (no additional filesystem I/O):

1. **Missing `worktree_setup`**: If the `worktree_setup` field is absent from the PortfolioEntry (not the same as `copy_paths: []`), warn: "Warning: [project] has no `worktree_setup` configured. This project was onboarded before worktree setup detection was available. Run `/onboard <path> rescan` to detect runtime config files, or proceed knowing the worktree may be missing runtime configuration." User must confirm to proceed.
2. **Empty `copy_paths` (intentional)**: If `worktree_setup` is present and `copy_paths` is an empty array, no warning is shown. An empty array is the explicit "no runtime files to copy" state — correct and intentional.
3. **Missing `portfolio_guides`**: If `portfolio_guides` is absent or empty, surface an advisory: "Note: [project] has no registered portfolio guides. Run `/onboard <path> rescan` to generate guides." Advisory only — does not block dispatch.
4. **Scope**: This check runs only when `worktree_mode: "auto"` + work_item_id present. Skipped for plan-mode dispatches, ad-hoc dispatches (no work item), `worktree_mode: "explicit"` projects, and `worktree_mode: "none"` projects (no worktree is attempted).
5. **Dashboard path**: The same check runs server-side in the dashboard dispatch endpoint (`POST /api/dispatch`) using the already-loaded `portfolio?.entry`. A warning response `{ warning: "...", require_confirm: true }` is returned to the browser before the dispatch proceeds. The dispatch UI must surface this and require user confirmation before spawning the agent.

## Error Recovery

| Scenario | Action |
|----------|--------|
| Agent exceeds maxTurns | Report partial progress to user, suggest splitting the task |
| Agent cannot proceed | Surface blockers to user, do not retry silently |
| Tests fail after implementation | Dispatch debugger to investigate, then coder for fix |
| Review finds critical issues | Coder addresses findings, re-review (max 2 iterations) |
| Scout finds no recognizable stack | Report findings, ask user to clarify project structure |

## Debug Artifact Rules

Rules governing debug artifacts (debug prints, temporary logging, debug flags, breakpoint markers, diagnostic instrumentation) introduced during investigation and fix workflows.

- **Preservation**: Debug artifacts persist through investigation → fix → verification. No agent removes them prematurely — they are needed for coder implementation context and tester verification.
- **Cleanup**: After tester verification passes, the orchestrator dispatches coder to remove all debug artifacts before the work is marked done. The final commit must not contain debug artifacts introduced during the workflow.
- **Scope**: Only artifacts introduced during the current workflow are subject to cleanup. Existing project logging, observability, and instrumentation are never touched.
- **Project guidelines precedence**: When the portfolio entry contains debug-related guidance (`portfolio_guides`, `agents.dispatch_notes.debugger`, debug-relevant `custom_rules`), those conventions take precedence over generic debug practices. Agents must follow project-specific debug functions, flags, and tools when specified.

## Expanded Agent Inclusion Rules

Additional inclusion conditions beyond the base Agent Inclusion Rules table.

| Agent | Also include when |
|-------|-------------------|
| documenter | Public API changes, new modules or subsystems introduced |
| dependency-manager | Package manifest changes (package.json, pubspec.yaml, requirements.txt, etc.) |
| performance | Changes to hot paths, database queries, or render-heavy components |
| ci-cd | Workflow file changes (.github/workflows/, .forgejo/workflows/) |

## Model Selection Rules

The orchestrator evaluates task complexity before each dispatch and sets the model explicitly. No agent uses `inherit` — every agent has an explicit default model, and the orchestrator overrides dynamically based on the task at hand.

### Complexity-to-Model Mapping

| Task Complexity | Default Model | Override Condition |
|-----------------|---------------|--------------------|
| trivial | haiku | — |
| small | sonnet | — |
| medium | sonnet | — |
| large | sonnet | Escalate to opus if task involves architecture decisions or cross-system design |
| strategic | opus | — |

### Quota Fallback

When sonnet quota is exhausted, the orchestrator falls back to opus for standard/complex tasks and haiku for trivial tasks.

### Canonical Agent Default Models

Static defaults defined in each agent's frontmatter. The orchestrator overrides these per-dispatch based on the complexity mapping above.

| Agent | Default Model | Role Category |
|-------|---------------|---------------|
| classifier | haiku | triage |
| coordinator | sonnet | dispatch-planning |
| git-ops | haiku | git-operations |
| scout | haiku | read-only |
| tracker | haiku | data-write |
| dependency-manager | haiku | read-only |
| coder | sonnet | implementation |
| coder-frontend | sonnet | implementation |
| coder-backend | sonnet | implementation |
| coder-mobile | sonnet | implementation |
| coder-infra | sonnet | implementation |
| tester | sonnet | implementation |
| reviewer | sonnet | read-only |
| debugger | sonnet | read-only |
| performance | sonnet | read-only |
| documenter | sonnet | implementation |
| api-designer | sonnet | implementation |
| refactorer | sonnet | implementation |
| ci-cd | sonnet | implementation |
| browser | sonnet | interactive |
| discuss | sonnet | interactive |
| profiler | sonnet | onboarding |
| planner | opus | read-only |
| strategist | opus | read-only |
| security-auditor | opus | read-only |
| tech-reviewer-swe | sonnet | read-only |
| tech-reviewer-arch | sonnet | read-only |
| tech-reviewer-dx | sonnet | read-only |
| tech-reviewer-ux | sonnet | read-only |
| tech-reviewer-frontend | sonnet | read-only |
| tech-reviewer-dba | sonnet | read-only |
| tech-reviewer-pm | sonnet | read-only |
| tech-reviewer-systems | sonnet | read-only |
| tech-reviewer-iot | sonnet | read-only |
| tech-reviewer-prod | sonnet | read-only |

### Review Board Escalation

Two review board agents escalate to opus when the artifact complexity is `large` or `strategic`:

| Agent | Escalated Model | Reason |
|-------|-----------------|--------|
| tech-reviewer-arch | opus | Structural integrity, layer boundary violations, and dependency flow require deep reasoning at large/strategic scale |
| tech-reviewer-systems | opus | Only dispatched for cross-system artifacts — inherently complex. Subsystem interaction failures and version compatibility edge cases benefit from opus reasoning |

All other tech-reviewer-* agents remain on sonnet regardless of complexity (domain-specific pattern checking, not deep structural reasoning).

## Role-Scoped Context Injection

Each agent receives only the context layers relevant to its role. This reduces token waste while ensuring agents have what they need. Organization conventions are always included regardless of role.

### Context Tier Mapping

| Context Tier | Agents | Fields Included |
|--------------|--------|-----------------|
| none | git-ops | Branch name and project path only |
| minimal | classifier, scout, tracker, dependency-manager, browser, discuss | `guidance.stack_summary`, `scout_report.language`, `scout_report.framework` |
| standard | coder, coder-frontend, coder-backend, coder-mobile, coder-infra, coordinator, findings-coordinator, planner, debugger, documenter, api-designer, refactorer, strategist, profiler, tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-dx, tech-reviewer-ux, tech-reviewer-frontend, tech-reviewer-dba, tech-reviewer-pm, tech-reviewer-systems, tech-reviewer-iot, tech-reviewer-prod | Minimal + `guidance.structure`, `guidance.conventions`, `custom_rules`, `agents.dispatch_notes`, `brief.purpose`, `brief.domain`, `brief.users`, `doc_paths`, `portfolio_guides` |
| full | tester, reviewer, security-auditor, ci-cd, performance | Standard + `guidance.ci_cd`, `guidance.testing`, complete `brief` (all fields), `doc_paths` |

### Application

- The orchestrator determines the tier from this table before loading context
- `loadPortfolioContext()` accepts a tier parameter and filters fields accordingly
- Dashboard dispatches use the same tier mapping (not always full)
- Portfolio guides are included at standard and full tiers, omitted at minimal and none

## Orchestrator Behavior Rules

The main Claude session acts strictly as an orchestrator: it reads, plans, dispatches, and tracks — but does not implement code (with the trivial exception below).

### Trivial Exception Rule

The orchestrator may handle single-line fixes inline without dispatching an agent:
- Typo corrections in string literals
- Single-character fixes
- Import statement additions
- Everything beyond this MUST be dispatched to the appropriate agent

### Dispatch Decision Flow

1. Is this a slash command? → Execute the skill directly (inline or dispatch per Skill Execution Policy)
2. Is this a trivial inline fix? → Handle directly
3. Is this a direct question? → Answer directly
4. Otherwise → Dispatch **classifier** (haiku) for fast triage
5. **Pre-dispatch check** (see Pre-Dispatch Check Rules): If classification type is a work type AND complexity >= small → run pre-dispatch check. If findings exist → present to user and get confirmation before proceeding. Runs in parallel with coordinator dispatch when both are needed.
6. If classifier returns `needs_coordinator: true` → Dispatch **coordinator** (sonnet) for detailed planning
7. Follow the dispatch plan from classifier or coordinator

### Dispatch-First Rule

The orchestrator dispatches sub-agents for research, analysis, and investigation tasks. The main session decomposes, dispatches, and synthesizes results — sub-agents execute. This reduces opus token consumption and enables parallel execution.

| Condition | Action |
|-----------|--------|
| Task classified as `small+` work type by classifier or orchestrator | Dispatch to appropriate agent |
| Task requires reading >3 files | Dispatch Explore agent(s) |
| Task spans >1 component or project | Dispatch with full project context |
| Task is pure analysis/research (no code modification) | Dispatch read-only agent at sonnet tier |
| Investigation spans >2 files or >1 component | Dispatch multiple read-only agents in parallel |
| Task is a direct question answerable from memory/context | Handle inline |
| Task matches Trivial Exception Rule | Handle inline |

The orchestrator's inline work should be limited to: decomposing tasks, constructing dispatch prompts, synthesizing agent results, answering direct questions, and running read-only git/API queries. Extended reading, analysis, and investigation belong in sub-agents.

### Investigation Findings Routing

When the orchestrator holds a ClassifierOutput (structured type/complexity/workflow signal from the classifier): follow the triage-request workflow.
When the orchestrator holds UnstructuredFindings (raw output from any investigation agent) and no ClassifierOutput: follow the synthesize-findings workflow.

### Git Operations

All git operations (commit, push, PR creation, branch management, worktree operations, merge) are delegated to the **git-ops** agent (haiku). The orchestrator does not run git commands directly except for read-only queries (status, log, diff for context).

### Orchestrator Session Model (Operator Guidance)

This guidance governs the model chosen for the **main-thread CLI session** itself. It is operator-applied at session start and is **not** enforced by architect dispatch or sub-agent overrides — the architect cannot select its own model at dispatch time.

- **Default**: Sonnet. Suitable for the vast majority of orchestration work (triage, planning, dispatching, synthesis).
- Escalation triggers — choose Opus when:
  - Task complexity is `strategic` (per the Complexity-to-Model Mapping table above), or
  - Task complexity is `large` AND the work involves architecture decisions or cross-system design.
- See the Complexity-to-Model Mapping table for canonical complexity labels (trivial/small/medium/large/strategic).
- **Limitation**: This is documentation-only guidance. The architect has no mechanism to verify or enforce the operator-selected session model at runtime, and recommendations may drift if not periodically reviewed.

> Footnote: The orchestrator is intentionally absent from the Canonical Agent Default Models table because no architect process programmatically selects its model — that choice lives with the operator launching the CLI session.

## Session Scope Rules

Every session has a `SessionIdentity` (see `domain/entities.md`) that determines its permissions. These rules define what each session type may and may not do.

### Session Type Permissions

| Capability | orchestrator (depth 0) | dispatch (depth 1) | terminal (depth 1) | cli (depth 0) |
|---|---|---|---|---|
| Spawn sub-agents (Agent tool) | Yes | Yes (depth 1 only) | Yes (depth 1 only) | Yes |
| Trigger dashboard dispatches | Yes | No | No | Yes |
| Create/kill terminal sessions | Yes | No | No | Yes |
| Modify any work item | Yes | No | No | Yes |
| Modify own work item | Yes | Yes | Yes | Yes |
| Create new work items (adjacent discoveries) | Yes | Yes | Yes | Yes |
| Read portfolio context | Yes (full) | Yes (tier-filtered) | Yes (tier-filtered) | Yes (full) |

### Depth Limit

- `dispatch_depth: 0` — main orchestrator or CLI session. Full capabilities.
- `dispatch_depth: 1` — dashboard-dispatched agent or terminal. Restricted to own work item scope. May spawn sub-agents via the Agent tool (in-process) but must not trigger further dashboard dispatches.
- `dispatch_depth: 2+` — forbidden. Sub-agents of dispatched agents run in-process only. They do not get their own session identity.

### Work Item Scope

Dispatched sessions (depth 1) operate within a bounded scope:
- **Read**: any work item, any portfolio entry within their context tier
- **Update**: only the work item they were dispatched for (status, session log)
- **Create**: new work items for adjacent discoveries are permitted (the orchestrator reviews these later)
- **Delete**: not permitted — only the orchestrator or user may cancel/delete work items

### Enforcement

These rules are enforced at two levels:
1. **Prompt-level**: The session identity and scope restrictions are injected into every dispatched agent's prompt (see dashboard prompt builder)
2. **Runtime-level**: API authorization middleware validates session identity on mutating endpoints (see follow-up ticket for implementation)

## Project Manager Behavior Rules

The orchestrator acts as a project manager across all onboarded projects. PM responsibilities are distinct from dispatch orchestration — they concern awareness, reporting, and proactive issue detection.

### Session Start Protocol

At the start of every conversation, the orchestrator runs a lightweight background check. This is **async and non-blocking** — it must not delay the orchestrator's first response to the user.

1. Check for active dispatches (running agents)
2. Check for active terminals
3. Check for in-progress work items across all projects
4. **Surface a summary only if findings are non-empty**: blocked items, stale dispatches, items needing attention, or cost anomalies
5. **Portfolio sync gate**: For each project with an in-progress or recently-active work item, query `knowledge_syncs` for the last completed sync. If `synced_at` is older than 6 hours or null (never synced), queue a background sync for that project. The sync runs async and non-blocking — it must not delay the first response to the user. If the sync detects commits classified as `architectural` or `dependency`, include a brief drift summary in the session-start surface alongside work item findings.
6. If no findings, proceed silently — do not report "all clear"

### Progress Reporting

When asked for project status or progress, the orchestrator produces a structured report:

1. Load work items for the target project, grouped by status (open, ready, in-progress, blocked, done, cancelled)
2. Identify blocked items and trace their blockers (what are they waiting on?)
3. Identify stale items — no status change or session log entry for 7+ days
4. If an epic is active, report epic progress: done items / total linked items, acceptance criteria coverage
5. Identify items with active dispatches vs items with no recent activity
6. Suggest next actions: which blocked items to unblock, which ready items to dispatch next, which stale items to review

### Cross-Org Coordination

When the user operates at the organization level (no specific project target, or explicit org-level request):

1. Load organization context for the target org
2. For each project in the org, summarize:
   - Active work items count and status distribution
   - Blocked item count and blockers
   - Latest activity (most recent session log entry date)
   - Active dispatches count
3. Detect cross-project dependencies: work items with `depends_on` references pointing to items in other project keys
4. Flag cross-project blockers: a blocked item in project A waiting on an item in project B that has no active dispatch
5. Report org-level cost summary if cost data is available

### Escalation Triggers

The orchestrator proactively detects and flags conditions using `EscalationLogEntry` format (see `domain/entities.md`):

| Trigger | Detection Criteria | Action |
|---------|-------------------|--------|
| `stale` | Work item has no status change or session log entry for 7+ days | Flag to user in status reports; suggest review or cancellation |
| `blocked-chain` | A blocked item's blocker (via `depends_on`) has no active dispatch and no recent progress | Flag to user; suggest dispatching work on the blocker |
| `epic-stall` | An active epic has had no linked item status change across the last 3 dispatches | Flag to user; suggest reviewing epic scope or priority |
| `cost-anomaly` | A single dispatch `cost_usd` exceeds 2x the project's average dispatch cost | Flag to user; suggest reviewing the dispatch for inefficiency |
| `dispatch-loop` | A work item has been dispatched 3+ times (counted via session log entries) without reaching `done` status | Flag to user; suggest manual investigation or scope reduction |
| `portfolio-drift` | A portfolio project's `change_log_entries` contain unreviewed `architectural` or `dependency` commits AND `knowledge_syncs.synced_at` is older than 24 hours | Surface in session-start block; suggest running `/sync` before dispatching agents on the affected project |

Escalation entries are recorded as session log entries on the affected work item using the `EscalationLogEntry` schema. The orchestrator presents escalations to the user — it does not take autonomous corrective action.

### Reconciliation with Work Item Rules

PM behavior rules complement, not replace, existing Work Item Rules and Epic Rules. The PM layer adds proactive detection on top of the passive tracking system. Work item status transitions remain governed by Work Item Rules.

## Retry and Feedback Policy

No automatic re-dispatch on failure. The orchestrator receives failure information and makes an informed decision.

### Protocol

1. Agent encounters failure (test failure, build error, implementation error, review rejection)
2. Agent returns structured failure info: what failed, what was attempted, partial results
3. Orchestrator receives failure info and decides:
   - Re-dispatch the same agent with modified approach
   - Dispatch a different agent (e.g., debugger to investigate a test failure)
   - Escalate to user with context
4. Maximum 2 retry attempts before mandatory user escalation
5. The orchestrator always informs the user of failures — no silent retries

### Contrast with Current Error Recovery

The existing Error Recovery table (above) defines what agents do when they encounter problems. This policy governs the orchestrator's response to agent-level failures. Both apply: agents follow Error Recovery; the orchestrator follows this policy.

## ADR Creation Rules

An ArchitecturalDecisionRecord is created when a decision affects one or more of: technology stack, data storage strategy, agent dispatch model, Clean Architecture layer boundaries, external dependencies, or performance/security trade-offs.

### Who May Author ADRs

- **orchestrator** — when the user explicitly requests an ADR, or when a self-referential architectural decision is made about the architect system
- **strategist** — when its assessment warrants a recorded decision; the strategist writes to `portfolio/<org>/<project>/adrs/ADR-NNN.json` (not `docs/decisions/`) and updates the component entry's `adrs` array
- **tech-reviewer-arch** — when a review uncovers an architectural constraint that should be recorded

### Lifecycle

1. A draft ADR starts with `status: proposed`. It is presented to the user before being written.
2. On user confirmation, the ADR is written to the portfolio and its ID added to the component entry's `adrs` array.
3. `status: proposed` ADRs are never injected into agent context.
4. Only `status: accepted` ADRs are included in the `# Architectural Decisions` section of dispatch prompts (standard and full tiers).
5. When a decision supersedes an existing ADR: set the old ADR's `status` to `superseded` and `superseded_by` to the new ADR's ID.

### ADR Suggestions from Sync

When the sync process flags a commit as `adr_candidate: true`, the orchestrator surfaces a suggestion to the user: "This commit looks like an architectural decision. Run `/sync adr <project> <sha>` to draft an ADR." This is advisory — no ADR is created without user confirmation.

## Sync Rules

Portfolio sync is the process of scanning a managed project's git history since the last sync anchor (`commit_from`) and recording new commits as `ChangeLogEntry` rows and a `SyncRecord` row.

### Staleness Windows

- **6 hours** (soft threshold): session-start gate triggers a background sync
- **24 hours** (hard limit): triggers a `portfolio-drift` escalation entry; agents dispatched to the project receive a staleness warning in their `# Project Context` section

### Sync Triggers

1. **Session start** (async, non-blocking): runs when `knowledge_syncs.synced_at` is older than 6 hours for any active project
2. **Scheduled** (CronCreate, `0 8 * * *`): daily 8 AM scan of all portfolio projects; exits early (skipped) if a project was synced within 4 hours
3. **Manual** (`/sync` skill): explicit user request, always runs regardless of staleness

### Sync Process

1. Read `knowledge_syncs` for the last `commit_to` SHA per project (the anchor)
2. Run: `git -C <path> log <commit_from>..HEAD --format="%H %ai %s" --no-merges --name-only 2>/dev/null`
3. Parse commits and classify each via `sync-classifier.mjs` (heuristic-only, no agent dispatch)
4. Flag commits with `adr_candidate: true` when message contains architectural-decision language AND affected files include architecture-layer paths
5. Insert `ChangeLogEntry` rows (unique on `project_key + commit_hash`)
6. Upsert `SyncRecord` with final counts and `summary_json`
7. Prune `change_log_entries` to last 90 days and max 100 entries per project

### Agent Context Injection

- Injected at **standard and full tiers only** (not minimal or none)
- Only `architectural` and `dependency` classified entries are included
- Capped at 10 entries and 3000 characters total per dispatch
- Section omitted entirely if no ADRs exist and no significant changes are present
- When `synced_at` is older than 24 hours, dispatch prompts include a staleness warning in `# Project Context`

### Graceful Degradation

- Repo path not found: log `status=skipped`, continue session silently
- `git` command fails (network, auth): log `status=failed` with error, preserve previous `commit_to` for retry
- Sync blocked by a concurrent run (same `project_key` already `running`): log `status=skipped`

## Skill Execution Policy

Skills are classified as **inline** (executed directly by the orchestrator) or **dispatch** (delegated to agents). The threshold: skills that take <30 seconds and do not modify code execute inline.

| Skill | Execution | Reason |
|-------|-----------|--------|
| /portfolio | inline | Read-only, fast |
| /work | inline | API calls only, fast |
| /status | inline | Read + API, fast |
| /worktree | inline | Git read commands, fast |
| /explain | dispatch | Extended analysis |
| /review | dispatch | Extended code reading |
| /test | dispatch | Runs tests, may modify |
| /deploy | dispatch | Side effects |
| /pr | dispatch | Git + GitHub operations |
| /diagnose | dispatch | Extended investigation |
| /secure | dispatch | Extended analysis |
| /implement | dispatch | Full SDLC cycle |
| /migrate | dispatch | Extended, modifies code |
| /release | dispatch | Side effects (git tags) |
| /refactor | dispatch | Modifies code |
| /browse | dispatch | Browser interaction |
| /scaffold | dispatch | Creates files |
| /onboard | dispatch | Extended scan + writes |

## Contract-First Planning Rules

Every plan that introduces new API endpoints, UI interactions, or agent dispatch flows must define a contract test before implementation begins.

1. **Write contract tests first**: Create an E2E or integration test spec that encodes the expected behavior (API response shapes, UI element presence, prompt content). These tests must fail (red) before any implementation code is written.
2. **Implementation makes tests pass**: The implementation is considered complete only when all contract tests pass (green) and no existing tests regress.
3. **Test placement**: Dashboard contracts go in `tools/dashboard/tests/`. Other projects use their own test infrastructure. Test files follow the naming convention `<feature>.spec.mjs`.
4. **Contract scope**: At minimum, cover the API layer (request/response contracts), the UI layer (element rendering, user interactions), and any prompt/context assembly (content verification).
5. **Exemptions**: Trivial changes (typo fixes, single-line edits, documentation-only) are exempt. If in doubt, write the contract.

## Review Board Rules

The Review Board is a context-filtered group of specialized review agents (3–10) that evaluate artifacts (plans, code diffs, PRs) from multiple perspectives. It operates as a two-gate quality system in the work item lifecycle.

### Review Board Agents

**Required (always dispatched)**:

| Agent | Perspective |
|-------|-------------|
| tech-reviewer-swe | Testability, Clean Code enforcement, performance, security, dependency management, tech debt |
| tech-reviewer-arch | Clean Architecture enforcement, layer boundaries, structural soundness, integration points |
| tech-reviewer-pm | Scope alignment, risk assessment, milestone impact, dependency tracking, effort estimation |

**Context-dependent (dispatched when context matches)**:

| Agent | Perspective | Dispatch when |
|-------|-------------|---------------|
| tech-reviewer-frontend | Component architecture, state management, rendering performance, browser compat, responsive design | Project has frontend stack OR artifact touches UI/component code |
| tech-reviewer-ux | User flows, interaction design, accessibility, cognitive load, error states | Project has user-facing interfaces OR artifact introduces user flows |
| tech-reviewer-dx | API surface, CLI ergonomics, configuration, Clean Code naming on APIs | Project has developer-facing surfaces (APIs, CLIs, SDKs, agent prompts) OR artifact changes developer APIs |
| tech-reviewer-dba | Schema design, query patterns, indexing, migrations, Clean Architecture data layer | Project uses a database OR artifact touches schema/query/model code |
| tech-reviewer-systems | System boundaries, communication protocols, cross-subsystem failure modes, version compat | Project spans multiple subsystems OR artifact crosses system boundaries |
| tech-reviewer-iot | Device provisioning, OTA, telemetry, power management, BLE, connectivity resilience | Project involves IoT/embedded devices OR artifact touches device-layer code |
| tech-reviewer-prod | Logging, monitoring, health checks, deployment safety, config management, graceful degradation, operational documentation | Project has backend services or APIs OR artifact introduces new deployment units, secrets/config management, or changes to operational runbooks. Skip for purely frontend-only artifacts with no deployment changes. |

All agents are read-only. tech-reviewer-arch and tech-reviewer-systems escalate to opus for large/strategic artifacts; all others use sonnet. See Model Selection Rules → Review Board Escalation.

### Context-Based Board Composition

The orchestrator assembles the board using three context signals (checked in order):
1. **Portfolio entry** — `scout_report.language`, `scout_report.framework`, `guidance.stack_summary`, tags
2. **Artifact content** — keywords/patterns in the plan text or diff being reviewed
3. **Work item metadata** — tags, title, description

**Resolution rule**: When portfolio entry is missing or incomplete, fall back to artifact content scanning. When both are inconclusive, include the reviewer (over-inclusion is cheaper than missing a perspective).

### Artifact Types

The board reviews three artifact types:
1. **Plan** — text output from the planner agent
2. **Diff** — staged changes, branch diffs, or file-scoped diffs
3. **PR** — PR diffs plus PR metadata (title, description, labels, linked issues)

### Two-Gate Lifecycle

The board operates as two gates in the work item lifecycle:

```
open → [Plan Gate] → ready → in-progress → [Code Gate] → done
```

| Gate | Trigger | Artifact Type | Success Outcome |
|------|---------|---------------|-----------------|
| Plan Gate | Plan produced by planner (medium+ complexity) | plan | Work item status → `ready` |
| Code Gate | Implementation complete, before merge | diff or pr | Work item status → `done` |

### Orchestrator Flow

1. Orchestrator determines which agents to dispatch using context-based composition rules
2. Orchestrator dispatches all selected tech-reviewer-* agents **in parallel** with the artifact and target project portfolio context as input
3. Orchestrator collects all `TechReviewVerdict` results (see `domain/entities.md`)
4. Orchestrator applies aggregation rules to determine `TechReviewBoardResult`

### Aggregation Rules

| Condition | Result |
|-----------|--------|
| Any verdict is `block` | Artifact does NOT proceed. Orchestrator feeds all concerns back to planner (plan gate) or coder (code gate) for revision, then re-runs the review board. Maximum 2 revision cycles before mandatory user escalation. |
| Any verdict is `revise` (none `block`) | Orchestrator presents artifact to user WITH revision concerns highlighted. User decides: accept as-is, request revision, or override. |
| All verdicts are `approve` | Artifact proceeds. Plan gate: status → `ready`. Code gate: proceed to commit/merge. |

### Exemptions

- Trivial or small complexity work items skip the plan gate (no planner involved)
- The code gate runs for all non-trivial code changes
- Direct agent dispatches without a planning phase skip the plan gate
- Plans provided by the user (not generated by the planner agent) skip the plan gate

### Integration Points

1. `usecases/implement-work-item.md` step 6 — **Plan Gate**: after plan generation, before user confirmation. On approve → status `ready`.
2. `usecases/implement-work-item.md` step 11 — **Code Gate**: after tests pass, before commit. On approve → proceed to commit.
3. `usecases/review-code.md` — Code Gate runs alongside the reviewer agent for detailed findings.
4. `usecases/create-pr.md` — Code Gate runs before PR creation. Block verdicts warn the user.
5. `plan-then-execute` workflow — Plan Gate runs after planner produces task decomposition.
6. Any coordinator dispatch that includes a planner step — Plan Gate runs after planner completes.

## Isolated Work Mandate

These rules apply to all medium+ complexity dispatches without exception. They are enforced at the API boundary, injected into every dispatch prompt, and required in every coordinator DispatchPlan.

### Core Rules
1. **Worktree required**: Every medium+ dispatch must execute in an isolated git worktree. The worktree branches off the currently checked-out branch at dispatch time (source_branch). Never branch off main by default.
2. **Complete contract required**: Every medium+ dispatch must have a complete DispatchContract with all four core fields (goal, constraints, expected_output, failure_conditions) plus e2e_test_criteria (minimum 1 entry; 3+ for large complexity).
3. **Plan Gate required**: Every medium+ DispatchPlan must include a plan-gate review step (Review Board) before any implementation agent runs. Board: tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm, tech-reviewer-dx.
4. **Code Gate required**: Every medium+ DispatchPlan must include a code-gate review step as the final pre-merge step. The code gate must verify contract satisfaction (each e2e_test_criteria item is implemented and passing). Board: tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-prod, plus tech-reviewer-dba if DB changes present, tech-reviewer-security if auth/secrets present.
5. **Base branch merge**: Merge always targets source_branch (the originating branch captured at worktree creation time). Never hardcode main as merge target.

### Ticket Gate (Orchestrator Behavior Extension)
For medium+ complexity, after the coordinator produces a DispatchPlan:
1. Surface the plan to the user immediately (visibility is non-blocking).
2. Simultaneously dispatch a Ticket Gate board review (same board as Plan Gate Board) as an async parallel step.
3. Incorporate board feedback before proceeding to dispatch any implementation agent.
4. If board blocks, revise the plan (max 2 revision cycles) before dispatching.
5. Override note: This extends the existing rule that surfaces coordinator output for user approval — plan is visible immediately but implementation dispatch is gated on board clearance.

### Recursion Guard
Gate reviews (Ticket Gate, Plan Gate, Code Gate) are read-only, depth-1 dispatches. They do NOT trigger further gate reviews. Maximum gate recursion depth: 1.

### Named Board Compositions
- **Ticket Gate Board** (identical to Plan Gate Board): tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm, tech-reviewer-dx
- **Plan Gate Board**: tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm, tech-reviewer-dx
- **Code Gate Board**: tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-prod; add tech-reviewer-dba if DB schema changes present; add tech-reviewer-security if authentication, secrets, or external data involved

## External Action Rules

- **Never post comments, reviews, or any content to GitHub pull requests unless the user explicitly requests it.** This applies to all agents, skills, and orchestrator actions. Read-only operations (fetching PR diffs, viewing comments, reading PR metadata) are always allowed. The restriction covers `gh pr comment`, `gh pr review`, and any GitHub API call that writes to a PR.

## Token & Credential Management Rules

- **Before creating any token, API key, credential, or named resource on a third-party service, always ask the user for the token name.** Never create tokens silently.
- Suggest a name following the organization-level `token_naming` convention from `portfolio/<org>/organization.json`. If no org convention exists, suggest the default pattern: `<UserName> <context> <service> <purpose>`.
- When performing any named action on behalf of the user — creating accounts, registering webhooks, naming cloud resources, generating SSH keys — ask for the preferred name or confirm a suggestion before proceeding.
- Token names must be identifiable and traceable: a person reading the token name later should understand who created it, from which device/context, for which service, and for what purpose.
- This rule applies to all agents, skills, and orchestrator actions across all portfolio projects.
