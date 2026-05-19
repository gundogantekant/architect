---
name: portfolio
description: View and manage the project portfolio registry
execution: inline
user_invocable: true
arguments:
  - name: action
    description: "'list' to show all entries, 'show <org/project/component>' for details, 'remove <org/project/component>' to unregister"
    required: false
---

# /portfolio

View and manage the architect project portfolio.

## Agents Dispatched
- None (direct data operations on portfolio files)

## Steps

1. **Parse the action** from `$ARGUMENTS.action` (default: `list`):
   - `list` — show all registered projects
   - `show <path>` — display a component profile (`<org/project/component>` or absolute path)
   - `remove <path>` — unregister a component from the portfolio

2. **For `list`**:
   - Read `portfolio/registry.json`
   - For each entry, read the component profile to get name, role, last_scanned
   - Read each org's `organization.json` for org-level context
   - Display a table grouped by organization:
     ```
     neuronic/
       light-app/main    Light App Mobile    mobile-frontend    scanned: 2026-02-22
       cloud/cloud-main  (not onboarded)
       firmware/light-firmware (not onboarded)
       flasher/main      (not onboarded)
     ```

3. **For `show <path>`**:
   - If `<path>` is an absolute filesystem path, look it up in `portfolio/registry.json`
   - If `<path>` is `org/project/component`, read `portfolio/<org>/<project>/<component>.json` directly
   - Display the full profile: stack summary, agents, guidance, conventions, custom rules
   - Also display the org-level rules from `organization.json`

4. **For `remove <path>`**:
   - Resolve the component as in `show`
   - Ask for user confirmation before removing
   - Delete the component JSON file
   - Remove the entry from `portfolio/registry.json`
   - Do not delete the project directory or org directory (other components may exist)
   - Note: `/portfolio remove` is a shallow unregister (files only). For full cleanup with work item cancellation, dispatch cancellation, worktree removal, and CLAUDE.md deletion, use `DELETE /api/portfolio/:org/:project/:component`. See `docs/portfolio.md` → Detach a Project.

## Output

- Formatted portfolio listing, profile details, or removal confirmation
