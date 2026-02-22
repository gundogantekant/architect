---
name: secure
description: Run a security audit on the project
user_invocable: true
---

# /secure

Run a comprehensive security audit.

## Steps

1. **Load portfolio context**:
   - Resolve the target project path (from cwd or arguments)
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/<project>/<component>.json` and `portfolio/<org>/organization.json`
   - If not found: fall back to running the **scout** agent to detect the project stack inline

2. Use the **security-auditor** agent (model: opus) to perform a full audit:
   - OWASP Top 10 analysis
   - Secrets detection (hardcoded keys, committed .env files)
   - Dependency vulnerability scan
   - Authentication/authorization review
   - Infrastructure security (Docker, CI/CD)
   - Input validation assessment

3. Use the **dependency-manager** agent (model: haiku) to:
   - Check for known CVEs in dependencies
   - Report outdated packages with security patches

4. Combine results into a unified security report

## Output

### Security Report
- Overall risk level (CRITICAL/HIGH/MEDIUM/LOW)
- Findings organized by severity
- Each finding includes: location, description, impact, remediation
- Dependency vulnerability list
- Prioritized action items
