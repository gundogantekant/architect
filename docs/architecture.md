# Architecture

Clean Architecture adapted for a prompt-based agent system. Four layers with inward-only dependencies.

## Layers

```
┌──────────────────────────────────────┐
│  Infrastructure                      │
│  portfolio/, work/, templates/       │  Layer 4: Data storage, external tools
├──────────────────────────────────────┤
│  Adapters                            │
│  .claude/agents/, .claude/skills/    │  Layer 3: Agent prompts, skill entry points
├──────────────────────────────────────┤
│  Use Cases                           │
│  usecases/                           │  Layer 2: Workflow definitions
├──────────────────────────────────────┤
│  Domain                              │
│  domain/                             │  Layer 1: Entity schemas, business rules
└──────────────────────────────────────┘
```

## Dependency Rule

Dependencies point inward only. Inner layers never reference outer layers.

| Layer | Can reference | Must not reference |
|-------|--------------|-------------------|
| Domain (`domain/`) | Nothing external | `portfolio/`, `work/`, `.claude/`, `templates/` |
| Use Cases (`usecases/`) | `domain/` | `.claude/agents/`, `.claude/skills/`, specific infrastructure paths |
| Adapters (`.claude/`) | `domain/`, `usecases/` | — |
| Infrastructure | Any layer | — |

## What lives where

### Domain (`domain/`)
- `entities.md` — canonical schemas for Agent, WorkItem, ScoutReport, DispatchPlan, PortfolioEntry, Organization, etc.
- `rules.md` — business rules: complexity heuristics, workflow selection, agent inclusion, permission model, clarification triggers

### Use Cases (`usecases/`)
- One file per workflow (13 total)
- Each defines: purpose, input, output, preconditions, agent(s), steps, post-conditions
- References `domain/entities.md` for schemas and `domain/rules.md` for decision logic
- `load-portfolio-context.md` is the shared precondition used by most skills

### Adapters (`.claude/agents/`, `.claude/skills/`)
- Agent prompts: define agent behavior, reference domain for schemas instead of embedding them inline
- Skill entry points: thin wrappers that delegate to use case files
- Output formatting stays in agent prompts (adapter concern)

### Infrastructure (`portfolio/`, `work/`, `templates/`)
- JSON data files (portfolio entries, backlog, registry)
- Project templates for scaffolding
- No business logic

## Boundary Checks

Verify architecture integrity by checking:

1. `domain/` files contain zero references to `.claude/`, `portfolio/`, `work/`, or `templates/`
2. `usecases/` files reference only `domain/` and generic concepts, not specific agent `.md` files
3. Agent prompts reference `domain/` for schemas instead of duplicating them
4. Skills delegate to `usecases/` instead of embedding full workflow logic
5. No entity schemas are duplicated across multiple agent prompts

The **reviewer** agent includes these boundary checks in its Architecture checklist.
