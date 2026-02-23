# Use Case: Create Release

Version bump, changelog generation, git tag, and optional GitHub release.

## Input
- Version bump type: `major`, `minor`, `patch`, or explicit version string
- Release notes scope: auto-generate from git log or user-provided

## Output
- Updated version in manifest files
- Generated CHANGELOG entry
- Git tag created
- Optional GitHub release published

## Preconditions
- Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: proceed without context, operate on git history)
- Must be on a clean working tree (no uncommitted changes)

## Agent(s)
- **documenter** (sonnet) — changelog generation from git log
- **coder** (inherit) — version bump in manifest files
- **ci-cd** (sonnet) — GitHub release creation (optional)

## Steps

1. Load portfolio context for package manager and conventions
2. Verify clean working tree (`git status`)
3. Determine current version from manifest file (package.json, pubspec.yaml, pyproject.toml, Cargo.toml)
4. Calculate next version based on bump type
5. Present version change for user confirmation
6. Documenter generates changelog entry:
   - Read git log since last tag (`git log <last-tag>..HEAD --oneline`)
   - Group commits by type (features, fixes, other)
   - Produce formatted CHANGELOG entry
7. Coder updates version in manifest files
8. Present all changes for user review
9. If approved:
   - Commit version bump and changelog
   - Create git tag (`v<version>`)
   - If user requests: create GitHub release via `gh release create`

## Post-conditions
- Version is bumped in all relevant manifest files
- CHANGELOG.md is updated with the new entry
- Git tag is created locally
- Push and GitHub release only happen with explicit user approval
