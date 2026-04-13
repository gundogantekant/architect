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
- **tech-reviewer-*** (model: sonnet, read-only) — Technical Review Board for governance verdicts (context-filtered, 3–9 agents)

## Steps

1. Load portfolio context for org conventions
2. Check git status (staged, unstaged, untracked changes)
3. Determine base branch from arguments (default: main)
4. If already on a worktree branch (detected via `git rev-parse --git-common-dir` not resolving to `<target-path>/.git`): skip branch creation, use the existing worktree branch
5. If on main: ask user for branch name, apply org branch prefix if applicable, create branch
6. Reviewer agent reviews branch diff and generates summary
7. **Technical Review Board — Code Gate** (per `domain/rules.md` → Technical Review Board Rules): Assemble the review board using context-based composition rules. Dispatch all selected tech-reviewer-* agents **in parallel** with the branch diff (artifact_type=pr) and portfolio context. Collect `TechReviewVerdict` from each. Apply aggregation rules:
   - Any `block` → warn user before creating PR, present block concerns. User decides: fix, override, or abort.
   - Any `revise` → include revision concerns in PR body.
   - All `approve` → proceed.
8. Create PR via `gh pr create`:
   - Title: under 70 characters, apply org PR title pattern if applicable
   - Body: summary, review findings, board verdicts summary, test plan checklist
9. Present PR URL

## Post-conditions
- Never push to main directly
- Always create feature/fix branches
- Do not skip pre-commit hooks
- Do not amend existing commits
- Board verdicts are included in PR body
