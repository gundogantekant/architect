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

1. Check git status to identify all changes (staged, unstaged, untracked)

2. Determine the base branch:
   - Use `$ARGUMENTS.base-branch` if provided
   - Default to `main`

3. Check if current branch is main:
   - If on main, ask the user for a branch name and create it
   - For Neuronic projects (detected by path containing "NeuronicRepos"), use GEN-XXX naming convention

4. Use the **reviewer** agent (model: opus) to review the changes:
   - Run a review on the branch diff
   - Generate a summary of changes

5. Create the PR using `gh pr create`:
   - Title: concise description of changes (under 70 characters)
   - For Neuronic projects, prefix title with GEN-XXX
   - Body includes:
     - Summary section with key changes
     - Review findings (if any critical issues, flag them)
     - Test plan checklist

6. Present the PR URL to the user

## Constraints

- Never push to main directly
- Always create feature/fix branches
- Do not skip pre-commit hooks
- Do not amend existing commits
