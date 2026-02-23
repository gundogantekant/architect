# Use Case: Deploy Local

Deploy the project locally using containers.

## Input
- Deployment target: "local" (default), "docker", "podman"
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Running services with exposed ports, health check status

## Preconditions
- Follow `usecases/load-portfolio-context.md` (fallback: run scout to detect container configuration)

## Agent(s)
- **coder-infra** (model: sonnet) — container config generation and deployment
- **scout** (model: haiku) — fallback detection

## Steps

1. Load portfolio context for container and stack info
2. If no container config exists:
   - coder-infra generates Dockerfile, docker-compose.yml or podman equivalent
   - Present configuration for user approval before creating files
3. If container config exists:
   - coder-infra validates, builds, and starts services
   - Report service status and exposed ports
4. Verify deployment health

## Post-conditions
- Ask before deploying to any non-local target
- Never deploy to production without explicit confirmation
