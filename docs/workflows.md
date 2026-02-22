# Multi-Agent Workflow Patterns

## 1. Sequential Pipeline

**Use for**: New feature development

```
scout -> planner -> coder -> tester -> reviewer
```

Each agent's output feeds the next. Scout detects the stack, planner designs the approach, coder implements, tester verifies, reviewer checks quality.

## 2. Parallel Fan-Out

**Use for**: Full-stack features with independent frontend/backend/infra work

```
       +-- coder-frontend (UI)
main --+-- coder-backend  (API)
       +-- coder-infra    (config)
              |
         tester -> reviewer
```

Dispatch implementation agents in parallel when their work doesn't conflict. Converge at testing and review.

## 3. Plan-Then-Execute

**Use for**: Large features requiring decomposition

```
planner -> [task list] -> dispatch coders per task
```

Planner produces a numbered task list. Main conversation dispatches appropriate coder agents for each task, parallelizing where possible.

## 4. Investigate-Then-Fix

**Use for**: Bug fixing

```
debugger/scout -> coder (fix) -> tester (verify)
```

Debugger identifies root cause, coder implements minimal fix, tester verifies the fix works and doesn't regress.

## 5. Review Feedback Loop

**Use for**: Quality enforcement before merging

```
coder -> reviewer -> coder (address) -> reviewer (re-check)
```

Iterate between implementation and review until all issues are resolved.

## 6. Strategic Evaluation

**Use for**: Ambiguous requests, large initiatives, build-vs-buy decisions

```
strategist -> planner -> coders -> tester -> reviewer
```

Strategist evaluates the request and produces a recommendation before any architecture work begins. Use when the request is vague, potentially over-scoped, or when there may be a simpler alternative to building.

## Orchestration Rules

- The main Claude conversation acts as orchestrator
- Subagents cannot spawn other subagents
- Pass scout's detection report to all subsequent agents
- Use parallel dispatch for independent work
- Use sequential dispatch when output feeds the next step
- Read-only agents (reviewer, security-auditor, performance) never modify code
