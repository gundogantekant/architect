---
name: explain
description: Codebase walkthrough for onboarding and knowledge transfer
user_invocable: true
arguments:
  - name: path
    description: Path to the project to explain (defaults to cwd)
    required: false
  - name: focus
    description: Specific module, layer, or feature to deep-dive into
    required: false
---

# /explain

Generate a structured architecture walkthrough of a project.

## Agents Dispatched
- **scout** (haiku) — stack detection (if no portfolio context)
- **documenter** (sonnet) — structured explanation generation

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **standard** (fallback: run scout to detect the stack)

2. Follow `usecases/explain-codebase.md` with:
   - path from `$ARGUMENTS.path` (default: cwd)
   - focus from `$ARGUMENTS.focus` (optional)

## Output

- Architecture overview with Mermaid diagram
- Technology stack summary
- Directory structure with purpose annotations
- Data flow description
- Key entry points for navigation
- Deep-dive into focus area (if specified)
