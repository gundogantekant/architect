---
name: migrate
description: Technology migration assistance
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

## Steps

1. **Load portfolio context**:
   - Resolve the target project path (from cwd or arguments)
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/<project>/<component>.json` and `portfolio/<org>/organization.json`
   - If not found: fall back to running the **scout** agent to understand the current project state

2. Use the **planner** agent (model: opus) to create a migration plan:
   - Analyze the scope of migration from `$ARGUMENTS.from` to `$ARGUMENTS.to`
   - Identify all affected files and components
   - Design a phased migration strategy
   - Identify risks and breaking changes
   - Estimate the migration scope

3. Present the migration plan to the user for approval:
   - Phase breakdown with dependencies
   - Risk assessment
   - Recommended approach (incremental vs big-bang)
   - Files affected per phase

4. If approved, execute the migration phase by phase:
   - Use appropriate coder agents for implementation
   - Use tester agent to verify each phase
   - Use reviewer agent to check migration quality

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
