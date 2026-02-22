---
name: onboard
description: Scan a project and register it in the architect portfolio
user_invocable: true
arguments:
  - name: path
    description: Path to the project to onboard
    required: true
  - name: organization
    description: "Organization name (auto-detected from path if under a known org's path_root)"
    required: false
  - name: rescan
    description: "Set to 'rescan' to refresh an existing profile's scout report"
    required: false
---

# /onboard

Scan a project's tech stack and register it in the architect portfolio.

## Steps

1. **Resolve portfolio location**:
   - Read `portfolio/registry.json` — check if `$ARGUMENTS.path` already exists
   - If found and `$ARGUMENTS.rescan` is not set: display the existing profile and exit
   - If found and `$ARGUMENTS.rescan` is set: proceed to step 2 (will update existing profile)

2. **Detect organization**:
   - Read all `portfolio/*/organization.json` files
   - If `$ARGUMENTS.organization` is provided, use that org
   - Otherwise, check if `$ARGUMENTS.path` starts with any org's `path_root` or `path_alias`
   - If no org matches, ask the user: create a new org or onboard without org association

3. **Run scout**:
   - Use the **scout** agent (model: haiku) to scan the target project at `$ARGUMENTS.path`
   - Detect language, framework, CI/CD, containers, database, testing, package manager
   - Produce the structured JSON detection report

4. **Determine recommended agents**:
   - All projects get: coder, tester, reviewer, debugger, documenter, dependency-manager
   - Frontend projects add: coder-frontend
   - Backend projects add: coder-backend
   - Mobile projects add: coder-mobile
   - Projects with CI add: ci-cd
   - Projects with containers add: coder-infra
   - Derive dispatch notes from the scout report

5. **Derive project and component names**:
   - Extract from the path: `<org-root>/<project>/<component>` → project = parent dir, component = leaf dir
   - If path is directly under org root (no nesting), component = dir name, project = dir name
   - Present the derived names to the user for confirmation

6. **Build the component profile** (JSON):
   - Populate: name, path, role, onboarded_at, last_scanned, scout_report, agents, guidance, custom_rules
   - For rescans: archive the current profile as `<component>.<date>.json` before overwriting

7. **Present for approval**:
   - Show the detection report, recommended agents, and profile summary
   - Wait for user confirmation before writing files

8. **Write to portfolio**:
   - Write the component profile to `portfolio/<org>/<project>/<component>.json`
   - Add/update the entry in `portfolio/registry.json`
   - If new org: create `portfolio/<org>/organization.json` with defaults

## Output

- Detection report (JSON)
- Component profile written to portfolio
- Registry updated
- No files written to the target project
