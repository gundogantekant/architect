---
name: onboard
description: Apply architect agents to an existing project by scanning its tech stack and generating configuration
user_invocable: true
arguments:
  - name: path
    description: Path to the project to onboard
    required: true
---

# /onboard

Apply the architect agent system to an existing project.

## Steps

1. Use the **scout** agent (model: haiku) to scan the target project at `$ARGUMENTS.path`:
   - Detect language, framework, CI/CD, containers, database, testing, package manager
   - Produce the structured JSON detection report

2. Based on the scout report, determine which agents are relevant for this project:
   - All projects get: coder, tester, reviewer, debugger, documenter, dependency-manager
   - Frontend projects add: coder-frontend
   - Backend projects add: coder-backend
   - Mobile projects add: coder-mobile
   - Projects with CI add: ci-cd
   - Projects with containers add: coder-infra

3. Generate a project-specific CLAUDE.md section that:
   - Documents the detected stack
   - Lists recommended agents and when to use each
   - Includes project-specific conventions detected by scout
   - Follows the existing CLAUDE.md format if one exists

4. Present the detection report and recommended configuration to the user for approval before writing any files.

## Output

- Detection report (JSON)
- Recommended agent list
- Generated CLAUDE.md additions (presented for approval)
