# Use Case: Scaffold Project

Create a new project from a template.

## Input
- Template type: backend-ts, frontend-react, mobile-expo, fullstack
- Project name

## Output
- New project directory, initialized git repo, portfolio profile registered

## Agent(s)
- **coder-infra** (model: sonnet) — template setup
- **scout** (model: haiku) — verification scan

## Steps

1. Validate template type against available templates in `templates/`
2. coder-infra copies template, replaces placeholder names, initializes git
3. Scout verifies detection on the new project
4. Run onboard use case (`usecases/onboard-project.md`) to register in portfolio

## Post-conditions
- New project at `./<name>` with working git repo
- Portfolio entry created via onboard
