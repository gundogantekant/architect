---
name: deploy
description: Local deployment via Docker Compose or Podman
user_invocable: true
arguments:
  - name: target
    description: "Deployment target: 'local' (default), 'docker', 'podman'"
    required: false
---

# /deploy

Deploy the project locally using containers.

## Steps

1. Follow `usecases/load-portfolio-context.md` (fallback: run scout to detect container configuration)

2. Follow `usecases/deploy-local.md` with target from `$ARGUMENTS.target`

## Output

- Running services with exposed ports
- Health check status
- Logs summary if any service fails to start

## Safety

- Always ask before deploying to any non-local target
- Never deploy to production without explicit confirmation
- Use environment-specific configuration
