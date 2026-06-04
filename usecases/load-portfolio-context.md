# Use Case: Load Portfolio Context

Shared precondition for all skills that need project context. Eliminates duplicated boilerplate across skill files.

## Input
- Target project path (from cwd or skill arguments)
- Depth tier: `minimal`, `standard`, or `full` (specified by the calling skill)

## Output
- Combined context at requested depth + organization conventions
- Or: fallback indicator if project is not in portfolio

## Context Depth Tiers

| Tier | Fields from PortfolioEntry | Used by |
|------|---------------------------|---------|
| none | Branch name and project path only | git-ops |
| minimal | `guidance.stack_summary` + `scout_report.language` + `scout_report.framework` | classifier, scout, tracker, dependency-manager, browser, work, portfolio |
| standard | minimal + `guidance.structure` + `guidance.conventions` + `custom_rules` + `agents.dispatch_notes` + `brief.purpose` + `brief.domain` + `brief.users` + `doc_paths` + `portfolio_guides` | coders, coordinator, planner, debugger, documenter, api-designer, refactorer, strategist, profiler, onboard |
| full | standard + `guidance.ci_cd` + `guidance.testing` + complete `brief` object + `doc_paths` | tester, ci-cd, reviewer, security-auditor, performance, deploy, migrate, status, secure |

Organization conventions (`organization.json`) are always loaded regardless of tier.

## Steps

1. Resolve the target project path (from cwd or skill arguments).
   If the target project path is not provided and cannot be inferred from cwd or conversation context, the skill must ask the orchestrator (which in turn asks the user) before proceeding. Skills must not silently default to cwd when the user's intent is ambiguous.
   When the user provided a project name (not an absolute path), apply the Portfolio-Aware
   Disambiguation algorithm from `domain/rules.md` → Target Project Identification before
   proceeding with git detection. This resolves the name to a registry-backed path (or
   presents candidates to the user) so the remaining steps have a concrete path to work with.
   - Run `git rev-parse --abbrev-ref HEAD` at the target path to capture the current branch
   - Run `git rev-parse --git-common-dir` at the target path to detect worktree status:
     if it does not resolve to `<target-path>/.git`, the path is inside a worktree
   - If inside a worktree: resolve the main repository root as the parent of git-common-dir
     (strip `/.git`) and use that for the registry lookup in Step 2
   - Carry the branch name and worktree flag forward for target label formatting
2. > Note: Portfolio root is `$ARCHITECT_PORTFOLIO_DIR` (injected by dashboard dispatch). When running as direct orchestrator CLI, default is `~/.architect/portfolio/`.

   Read `$ARCHITECT_PORTFOLIO_DIR/registry.json` and look up the path → get `{org, project, component}`
3. If found:
   - Read `$ARCHITECT_PORTFOLIO_DIR/<org>/<project>/<component>.json` (see `domain/entities.md` → PortfolioEntry)
   - Filter fields based on the requested depth tier
   - If `portfolio_guides` is present and the tier includes it (standard or full): read each listed file from `portfolio/<org>/<project>/` and include the contents in the context passed to agents
   - If `portfolio_guides` is absent or empty AND the tier is standard or full: check if `portfolio/<org>/<project>/local-dev-setup.md` exists. If it does, load it as a guide and surface to the orchestrator (not only agent context): "Note: `local-dev-setup.md` found for [project] but not registered in `portfolio_guides`. Run `/onboard <path> rescan` to register it." The orchestrator must relay this note to the user once per session at context-load time.
   - Read `portfolio/<org>/organization.json` for org-level conventions (see `domain/entities.md` → Organization)
   - Return combined context at requested depth
4. If not found:
   - Return fallback indicator — caller decides the fallback strategy (see Fallback Strategies below)

### Step 5 — Code Analysis Tool Availability (standard and full tiers, optional)

After loading portfolio guides, check whether a CodeGraph index exists at the **target project's absolute path** resolved in Step 1. Do not check the agent's cwd — always use the resolved target path.

1. Check if `<target-path>/.codegraph/` exists
2. If present, call `codegraph_status` to verify the index is current (not just that the directory exists — an empty or corrupted index must not be reported as available)
3. If `codegraph_status` reports the index is current, append a `### CodeGraph` subsection to the assembled context block:
   ```
   ### CodeGraph
   - Available: yes
   - Indexed scope: code files only (*.ts, *.js, *.mjs, *.py, etc.) — .md files are not indexed
   - Use codegraph_search, codegraph_callers, codegraph_callees, codegraph_impact for JS/TS symbol lookups and impact analysis
   - Fallback: use grep/find for .md artifacts and when CodeGraph is unavailable
   ```
4. If `.codegraph/` is absent or `codegraph_status` errors, omit the subsection entirely — do not inject a "CodeGraph: unavailable" note; just proceed without it

### Load Sync Context (standard and full tiers)

After loading portfolio guides, if the tier is `standard` or `full`:

1. Read the component entry's `adrs` array field (list of accepted ADR IDs like `["ADR-001", "ADR-002"]`)
2. For each ADR ID, read `portfolio/<org>/<project>/adrs/<id>.json`
3. Query `GET /api/sync/significant?project_key=<encoded-key>` for recent architectural/dependency commits
4. Query `GET /api/sync/:project_key/history` (first result) for `synced_at` timestamp
5. Assemble into a `syncContext` object: `{ adrs, recentChanges, lastSyncedAt }`
6. Include `syncContext` in the returned portfolio object passed to `buildDispatchPrompt()`

If the ADR directory doesn't exist or the sync API returns an empty result, return an empty `syncContext` (no ADRs, no recent changes). Never fail context loading because of missing sync data.

## Fallback Strategies

Each skill specifies its own fallback when no portfolio entry exists:

| Skill | Fallback |
|-------|----------|
| review | Proceed without portfolio context |
| deploy | Run scout agent to detect container configuration inline |
| diagnose | Proceed without portfolio context (debugger explores inline) |
| status | Run scout agent to scan the project |
| secure | Run scout agent to detect the project stack inline |
| test | Run scout agent to detect the testing framework inline |
| migrate | Run scout agent to understand the current project state |
| pr | Proceed without org conventions (no branch prefix enforcement) |
| explain | Proceed without context (scout runs as first step anyway) |
| release | Proceed without context (operates on git history) |

## Worktree Awareness

When a WorktreeContext is active (see `domain/entities.md` → WorktreeContext):
- Implementation agents use `worktree_path` as their working directory
- Read-only agents use `source_path` (the original project path)
- Portfolio lookup always uses `source_path` — never a worktree path
- Worktrees may be sibling directories of the project folder (not inside it); detection via
  `git rev-parse --git-common-dir` works regardless of worktree location
- When the target path is inside an external worktree, resolve `source_path` via
  `git rev-parse --git-common-dir` for registry lookups — the registry stores main
  repo paths only
- Branch name is always included in the target label passed to agents

## Org Boundary Awareness

- Include org name in context passed to agents ("Working in org: X")
- If a task spans multiple project keys, verify they belong to the same org unless explicitly cross-org (e.g., an epic)
- Agents receiving org context must apply org-level rules as baseline constraints

## Dashboard Dispatch

The dashboard (`tools/dashboard/prompt-builder.mjs` → `buildDispatchPrompt()`) applies **role-scoped context injection** for all dispatched agents. The orchestrator determines the appropriate tier from `domain/rules.md` → Role-Scoped Context Injection based on the agent's role, and `loadPortfolioContext()` accepts a tier parameter to filter fields accordingly. Organization conventions are always included. Agents dispatched from the dashboard also receive an explicit Architect System section declaring their portfolio location and knowledge base pointers, plus a Context Tiers section guiding sub-agent dispatch.

## Post-conditions
- All subsequent agents receive context filtered to the requested depth
- Context includes: stack info, conventions, recommended agents, dispatch notes (based on tier)

## Knowledge Isolation

- "Project files" in user requests refers to architect portfolio entries (`portfolio/<org>/<project>/`), not target project source files.
- Context loading always sources from the portfolio as the authoritative knowledge base.
- Portfolio guides and component profiles are the canonical project knowledge; target project files are raw material, not the knowledge base.
