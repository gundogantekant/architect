---
name: pr
description: Create a pull request with automated review summary
user_invocable: true
arguments:
  - name: base-branch
    description: Base branch to target (default: main)
    required: false
---

# /pr

Create a pull request with an automated review summary.

## Steps

1. **Load portfolio context**:
   - Resolve the target project path from cwd
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/organization.json` for org conventions (branch prefix, PR title pattern)
   - Use org conventions for branch naming and PR title formatting

2. Check git status to identify all changes (staged, unstaged, untracked)

3. Determine the base branch:
   - Use `$ARGUMENTS.base-branch` if provided
   - Default to `main`

4. Check if current branch is main:
   - If on main, ask the user for a branch name and create it
   - For projects with an org convention (e.g., Neuronic GEN-XXX), apply the org's branch prefix

5. Use the **reviewer** agent (model: opus) to review the changes:
   - Run a review on the branch diff
   - Generate a summary of changes

6. Create the PR using `gh pr create`:
   - Title: concise description of changes (under 70 characters)
   - For projects with org conventions, prefix title according to the org's pattern
   - Body includes:
     - Summary section with key changes
     - Review findings (if any critical issues, flag them)
     - Test plan checklist

7. Present the PR URL to the user

## Constraints

- Never push to main directly
- Always create feature/fix branches
- Do not skip pre-commit hooks
- Do not amend existing commits
