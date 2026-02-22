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

1. **Load portfolio context**:
   - Resolve the target project path (from cwd or arguments)
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/<project>/<component>.json` and `portfolio/<org>/organization.json`
   - If not found: fall back to running the **scout** agent to detect container configuration inline

2. If no container config exists, use the **coder-infra** agent to:
   - Generate appropriate Dockerfile for the project
   - Create docker-compose.yml or podman equivalent
   - Set up necessary services (database, cache, etc.)
   - Present configuration for user approval before creating files

3. If container config exists, use the **coder-infra** agent to:
   - Validate the configuration
   - Build and start services using the detected container runtime
   - Report service status and exposed ports

4. Verify deployment health

## Output

- Running services with exposed ports
- Health check status
- Logs summary if any service fails to start

## Safety

- Always ask before deploying to any non-local target
- Never deploy to production without explicit confirmation
- Use environment-specific configuration
