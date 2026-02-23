# Use Case: Load Portfolio Context

Shared precondition for all skills that need project context. Eliminates duplicated boilerplate across skill files.

## Input
- Target project path (from cwd or skill arguments)

## Output
- Combined context: component profile + organization conventions
- Or: fallback indicator if project is not in portfolio

## Steps

1. Resolve the target project path (from cwd or skill arguments)
2. Read `portfolio/registry.json` and look up the path → get `{org, project, component}`
3. If found:
   - Read `portfolio/<org>/<project>/<component>.json` for scout report, agents, and guidance (see `domain/entities.md` → PortfolioEntry)
   - Read `portfolio/<org>/organization.json` for org-level conventions (see `domain/entities.md` → Organization)
   - Return combined context
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

## Post-conditions
- All subsequent agents receive the combined context
- Context includes: stack info, conventions, recommended agents, dispatch notes
