# Use Case: Create PR

Create a pull request with automated review summary.

## Input
- Base branch (default: main)
- Portfolio context (from `usecases/load-portfolio-context.md`, org conventions only)

## Output
- PR URL

## Preconditions
- Follow `usecases/load-portfolio-context.md` — only org conventions needed (branch prefix, PR title pattern)
- Fallback: proceed without org conventions (no prefix enforcement)

## Agent(s)
- **reviewer** (model: opus, read-only) — change review and summary

## Steps

1. Load portfolio context for org conventions
2. Check git status (staged, unstaged, untracked changes)
3. Determine base branch from arguments (default: main)
4. If already on a worktree branch (under `.worktrees/`): skip branch creation, use the existing worktree branch
5. If on main: ask user for branch name, apply org branch prefix if applicable, create branch
6. Reviewer agent reviews branch diff and generates summary
7. Create PR via `gh pr create`:
   - Title: under 70 characters, apply org PR title pattern if applicable
   - Body: summary, review findings, test plan checklist
8. Present PR URL

## Post-conditions
- Never push to main directly
- Always create feature/fix branches
- Do not skip pre-commit hooks
- Do not amend existing commits
