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
| minimal | `guidance.stack_summary` + `scout_report.language` + `scout_report.framework` | dependency-manager, tracker, work, portfolio |
| standard | minimal + `guidance.structure` + `guidance.conventions` + `agents.dispatch_notes` + `brief.purpose` + `brief.domain` + `brief.users` + `doc_paths` | coders, planner, debugger, documenter, onboard |
| full | standard + `guidance.ci_cd` + `guidance.testing` + `custom_rules` + complete `brief` object + `doc_paths` | tester, ci-cd, reviewer, security-auditor, deploy, migrate, status, secure |

Organization conventions (`organization.json`) are always loaded regardless of tier.

## Steps

1. Resolve the target project path (from cwd or skill arguments)
   - Run `git rev-parse --abbrev-ref HEAD` at the target path to capture the current branch
   - Run `git rev-parse --git-common-dir` at the target path to detect worktree status:
     if it does not resolve to `<target-path>/.git`, the path is inside a worktree
   - If inside a worktree: resolve the main repository root as the parent of git-common-dir
     (strip `/.git`) and use that for the registry lookup in Step 2
   - Carry the branch name and worktree flag forward for target label formatting
2. Read `portfolio/registry.json` and look up the path → get `{org, project, component}`
3. If found:
   - Read `portfolio/<org>/<project>/<component>.json` (see `domain/entities.md` → PortfolioEntry)
   - Filter fields based on the requested depth tier
   - Read `portfolio/<org>/organization.json` for org-level conventions (see `domain/entities.md` → Organization)
   - Return combined context at requested depth
4. If not found:
   - Return fallback indicator — caller decides the fallback strategy (see Fallback Strategies below)

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
- When the target path is inside an external worktree, resolve `source_path` via
  `git rev-parse --git-common-dir` for registry lookups — the registry stores main
  repo paths only
- Branch name is always included in the target label passed to agents

## Post-conditions
- All subsequent agents receive context filtered to the requested depth
- Context includes: stack info, conventions, recommended agents, dispatch notes (based on tier)
