---
name: scaffold
description: Create a new project from a template
execution: dispatch
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

## Agents Dispatched
- **coder-infra** (sonnet) — template setup
- **scout** (haiku) — verification scan

## Steps

Follow `usecases/scaffold-project.md` with:
- type from `$ARGUMENTS.type`
- name from `$ARGUMENTS.name`

## Output

- New project directory at `./$ARGUMENTS.name`
- Initialized git repository
- Portfolio profile registered via `/onboard`
- Detection report confirming setup
