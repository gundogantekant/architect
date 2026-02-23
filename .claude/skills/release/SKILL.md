---
name: release
description: Version bump, changelog generation, git tag, optional GitHub release
user_invocable: true
arguments:
  - name: version
    description: "Version bump type: 'major', 'minor', 'patch', or explicit version (e.g. '2.1.0')"
    required: true
  - name: publish
    description: "Set to 'github' to also create a GitHub release"
    required: false
---

# /release

Create a release: bump version, generate changelog, create git tag.

## Agents Dispatched
- **documenter** (sonnet) — changelog generation from git log
- **coder** (inherit) — version bump in manifest files
- **ci-cd** (sonnet) — GitHub release creation (optional)

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: proceed without context)

2. Follow `usecases/create-release.md` with:
   - version from `$ARGUMENTS.version`
   - publish from `$ARGUMENTS.publish` (optional)

## Output

- Version bumped in manifest files
- CHANGELOG.md updated
- Git tag created
- GitHub release URL (if publish=github)

## Constraints

- Requires clean working tree
- Commit and tag only after user approval
- Never push without explicit confirmation
