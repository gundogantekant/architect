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
| browser | E2E tests, visual regression, bug reproduction in browser, or web automation tasks requested by the user |

## Agent Permission Model

| Category | Agents | Can modify code | Can write data | Can interact with web | Uses worktree |
|----------|--------|-----------------|----------------|-----------------------|---------------|
| Read-only | reviewer, security-auditor, performance, strategist, pm, scout, debugger, dependency-manager | No | No | No | No (main tree) |
| Interactive | browser | No | No | Yes | No |
| Implementation | coder, coder-frontend, coder-backend, coder-mobile, coder-infra, ci-cd, api-designer, documenter, refactorer | Yes | No | No | Yes (worktree) |
| Onboarding | profiler | No (writes only CLAUDE.md to target project) | No | No | No |
| Data-write | tracker | No | Yes (`work/backlog.json` only) | No | No |

**Exception**: strategist can write decision docs to `docs/`.
**Exception**: profiler writes only `CLAUDE.md` to the target project during onboarding.

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
Organization=–, Project=architect, Component=–.

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

- Use definitive variable names
- Do not write commented-out code
- Do not write comments in code files (keep TODO and DECISION tags only)
- Write self-explanatory code
- Prefer editing existing files over creating new ones
- Do not over-engineer or add unnecessary abstractions
- Avoid introducing security vulnerabilities (OWASP Top 10)
- Consider Linux compatibility

## Git Standards

Shared git rules enforced by all implementation agents.

- Never push to main; create feature or fix branches for all changes
- Commit only relevant changed files at the end of implementation
- Exclude Claude attribution from commit messages
- Never use --no-verify flag
- Avoid amending commits; prefer new commits

## Worktree Rules

- **All work on portfolio projects MUST use a worktree by default.** This applies to implementation agents, direct orchestrator edits, and any skill that modifies code in a portfolio project. The only exception is when the user explicitly requests working without a worktree (e.g., "edit in place", "no worktree", "work on main").
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

## Expanded Agent Inclusion Rules

Additional inclusion conditions beyond the base Agent Inclusion Rules table.

| Agent | Also include when |
|-------|-------------------|
| documenter | Public API changes, new modules or subsystems introduced |
| dependency-manager | Package manifest changes (package.json, pubspec.yaml, requirements.txt, etc.) |
| performance | Changes to hot paths, database queries, or render-heavy components |
| ci-cd | Workflow file changes (.github/workflows/, .forgejo/workflows/) |
