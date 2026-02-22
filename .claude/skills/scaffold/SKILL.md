---
name: scaffold
description: Create a new project from a template
user_invocable: true
arguments:
  - name: type
    description: "Template type: backend-ts, frontend-react, mobile-expo, fullstack"
    required: true
  - name: name
    description: Project name
    required: true
---

# /scaffold

Create a new project from a template.

## Available Templates

- **backend-ts**: TypeScript backend with NestJS/Fastify
- **frontend-react**: React + Vite + TypeScript web app
- **mobile-expo**: React Native + Expo + TypeScript
- **fullstack**: Turborepo monorepo (backend + frontend)

## Steps

1. Validate the template type is one of the available options
2. Use the **coder-infra** agent to:
   - Copy the template from `templates/$ARGUMENTS.type/` to the target location
   - Replace placeholder names with `$ARGUMENTS.name`
   - Initialize git repository
   - Set up the project structure
3. Run the **scout** agent on the new project to verify detection
4. Generate CLAUDE.md for the new project with appropriate agent recommendations

## Output

- New project directory at `./$ARGUMENTS.name`
- Initialized git repository
- Project-specific CLAUDE.md
- Detection report confirming setup
