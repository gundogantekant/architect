---
name: migrate
description: Technology migration assistance
execution: dispatch
user_invocable: true
arguments:
  - name: from
    description: Current technology
    required: true
  - name: to
    description: Target technology
    required: true
---

# /migrate

Plan and assist with technology migration.

## Agents Dispatched
- **planner** (opus) — migration plan
- **coder** variants (inherit) — implementation
- **tester** (sonnet) — phase verification
- **reviewer** (sonnet) — migration quality

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: run scout to understand the current project state)

2. Follow `usecases/migrate-stack.md` with from=`$ARGUMENTS.from` and to=`$ARGUMENTS.to`

## Common Migrations

- Flutter → React Native
- GitHub Actions → Forgejo Actions
- REST → GraphQL
- JavaScript → TypeScript
- Express → NestJS/Fastify
- npm → pnpm/bun
- Docker → Podman

## Constraints

- Always present plan before executing
- Migrate incrementally when possible
- Maintain backward compatibility during transition
- Keep the project buildable at each phase
