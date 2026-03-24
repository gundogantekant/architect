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
| PM | Populate `parallel_with` on every DispatchPlan step that shares no dependencies with another step. An empty `parallel_with` array means "evaluated, has dependencies" — not "not considered". When the workflow is `plan-then-execute`, note that the planner will refine parallelization at the task level. |
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
- **investigate-then-fix**: Investigation is always sequential; fix + test may parallelize if targeting separate components
- **PM-guided dispatch**: PM applies rules to the execution plan; orchestrator enforces them

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

## Agent Permission Model

| Category | Agents | Can modify code | Can write data | Can interact with web | Uses worktree |
|----------|--------|-----------------|----------------|-----------------------|---------------|
| Read-only | reviewer, security-auditor, performance, strategist, pm, scout, debugger, dependency-manager | No | No | No | No (main tree) |
| Interactive | browser | No | No | Yes | No |
| Implementation | coder, coder-frontend, coder-backend, coder-mobile, coder-infra, ci-cd, api-designer, documenter, refactorer | Yes | No | No | Yes (worktree) |
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
- Statuses: `open` → `in-progress` → `done` (or `blocked`, `cancelled`)
- Session log is append-only
- `list` supports `--org <name>` to filter by organization prefix
- `list` supports `--project` with comma-separated values for multi-project filtering
- `--org` and `--project` can be combined: org narrows first, project filters within

## Epic Rules

- Epics use `E-XXX` IDs (zero-padded, globally unique, never reused)
- One epic per work item maximum
- `project_keys` is auto-derived when items are linked/unlinked — never set manually
- Status transitions: `draft → active → done` (or `cancelled` from any state)
- Tracker agent suggests status transitions but does not auto-change them
- Epic docs stored at `work/epics/E-XXX/` (plan.md, docs.md) — created lazily
- Work item artifacts stored at `work/items/W-XXX/` (plan.md, docs.md) — created lazily. The `notes` field on WorkItem is deprecated; use file artifacts instead

## Dependency Rules

- `depends_on` is always an array (empty `[]` = no dependencies)
- Cross-project dependencies are allowed — IDs are globally unique
- Circular dependencies are forbidden: before adding A depends on B, DFS from B through `depends_on` edges; if A is reachable, reject the dependency
- Tracker suggests `blocked` status when unfinished dependencies exist, but does not auto-change status
- Topological sort (Kahn's algorithm) for display: roots first (no deps), then items whose deps are all listed; within same level, sort by priority desc then ID asc; items with external deps (outside filtered set) appended at end

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

## Coding Standards

Shared standards enforced by all implementation agents.

### Clean Code
- Use definitive variable names
- Write self-explanatory code — no comments except TODO and DECISION tags
- Do not write commented-out code
- Keep functions short and single-purpose
- Prefer editing existing files over creating new ones
- Do not over-engineer or add unnecessary abstractions

### Clean Architecture
- Respect layer boundaries — dependencies point inward (domain → usecases → adapters → infrastructure)
- Separate business logic from I/O, frameworks, and UI
- Define types, enums, and state values in the domain layer; reference them everywhere else
- New code must integrate through existing interfaces — do not bypass layers

### DRY
- Before defining a type, enum, constant, or state set, check if one already exists in the project's domain layer or shared definitions
- Extract repeated logic into shared utilities — three occurrences is the threshold
- Single source of truth: if a value is defined in one place, import or reference it; never redefine it

### General
- Avoid introducing security vulnerabilities (OWASP Top 10)
- Consider Linux compatibility

## Domain-First Rule

Before implementing any type, enum, state value, or schema:
1. Check `domain/entities.md` (for architect itself) or the target project's domain layer for an existing canonical definition
2. If one exists, import or reference it — do not redefine
3. If none exists and the concept is shared across layers, define it in the domain layer first, then reference it from implementation code

This applies to all implementation agents and the planner.

## Git Standards

Shared git rules enforced by all implementation agents.

- Never push to main; create feature or fix branches for all changes
- Commit only relevant changed files at the end of implementation
- Exclude Claude attribution from commit messages
- Never use --no-verify flag
- Avoid amending commits; prefer new commits

## Worktree Rules

- **All work on portfolio projects MUST use a worktree by default, unless the PortfolioEntry sets `worktree_mode: "explicit"`.** This applies to implementation agents, direct orchestrator edits, and any skill that modifies code in a portfolio project. When `worktree_mode` is `"explicit"`, agents work in-place on the current branch and only create a worktree when the user explicitly requests one. When `worktree_mode` is `"auto"` (the default), the only exception is when the user explicitly requests working without a worktree (e.g., "edit in place", "no worktree", "work on main").
- Read-only operations (review, audit, diagnosis, scouting) do not require a worktree.
- Worktrees are sibling directories of the project folder, not inside it
- Path: `<parent-of-project-dir>/<project-dir-name>-<branch-name>/`
- Branch/folder naming: `<project-dir-name>-<branch-prefix><ticket-id>-<slug>` (e.g., `light-app-GEN-1641-add-auth-flow`)
- Ticket ID comes from Notion (via MCP) or user input; the orchestrator obtains it before creating the worktree
- After worktree creation, `worktree_setup` hooks from the PortfolioEntry run if defined (copy paths, post commands)
- After implementation, the user decides: merge via `/pr` or discard via `/worktree cleanup`
- Portfolio registry always stores the original project path, never worktree paths

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
