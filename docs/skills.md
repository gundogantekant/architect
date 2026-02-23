# Skill Reference

## Available Commands

| Command | Purpose | Primary Agent |
|---------|---------|---------------|
| `/onboard [path] [rescan]` | Scan and register project in portfolio | scout |
| `/portfolio [action]` | View and manage project portfolio | — |
| `/scaffold [type] [name]` | Create new project from template | coder-infra |
| `/review [scope]` | Comprehensive code review | reviewer (sonnet) |
| `/test [scope]` | Run/generate tests, report coverage | tester |
| `/deploy [target]` | Local deployment via containers | coder-infra |
| `/pr [base-branch]` | Create PR with review summary | reviewer |
| `/diagnose [issue]` | Debug and investigate an issue | debugger |
| `/secure` | Run security audit | security-auditor |
| `/status` | Project health dashboard | scout + dependency-manager |
| `/work [subcommand]` | Track work items across sessions | tracker |
| `/migrate [from] [to]` | Technology migration assistance | planner |
| `/explain [path] [--focus area]` | Codebase walkthrough for onboarding | scout + documenter |
| `/release [version]` | Version bump, changelog, git tag | documenter + coder + ci-cd |
| `/refactor [scope]` | Systematic refactoring | planner + refactorer + tester + reviewer |

## Details

### /onboard
Scans an existing project, detects its tech stack, and registers it in the architect portfolio. Always run this first on a new project. No files are written to the target repo.

```
/onboard /path/to/project
/onboard /path/to/project rescan
/onboard /path/to/project --organization myorg
```

### /portfolio
View and manage the project portfolio registry.

```
/portfolio                                    # list all registered projects
/portfolio list                               # same as above
/portfolio show neuronic/light-app/main       # show full profile
/portfolio remove neuronic/light-app/main     # unregister a component
```

### /scaffold
Creates a new project from a template.

```
/scaffold backend-ts my-api
/scaffold frontend-react my-app
/scaffold mobile-expo my-mobile-app
/scaffold fullstack my-platform
```

### /review
Reviews code changes. Defaults to staged changes if no scope given.

```
/review              # staged changes
/review staged       # staged changes
/review branch       # branch diff vs main
/review src/api/     # specific directory
```

### /test
Runs or generates tests.

```
/test                # run all tests
/test run            # run all tests
/test generate       # generate missing tests
/test coverage       # run with coverage
/test src/utils/     # test specific files
```

### /deploy
Deploys locally using containers.

```
/deploy              # default local deployment
/deploy docker       # force Docker
/deploy podman       # force Podman
```

### /pr
Creates a pull request. For Neuronic projects, uses GEN-XXX naming.

```
/pr                  # PR against main
/pr develop          # PR against develop
```

### /diagnose
Investigates a bug.

```
/diagnose "Login fails with 500 error after password reset"
```

### /secure
Runs a full security audit.

```
/secure
```

### /status
Shows project health dashboard.

```
/status
```

### /work
Tracks work items across sessions with persistent storage.

```
/work                              Show open + in-progress items
/work add "Title" --project X --priority high --tags a,b
/work show W-001                   Full detail + session log
/work update W-001 in-progress     Change status
/work log W-001 "Progress note"    Append session log entry
/work list --status blocked        Filtered listing
/work remove W-001                 Delete (with confirmation)
```

### /migrate
Plans technology migration.

```
/migrate flutter react-native
/migrate github-actions forgejo
/migrate javascript typescript
```

### /explain
Generates a structured architecture walkthrough for onboarding.

```
/explain                          # explain current project
/explain /path/to/project         # explain specific project
/explain --focus auth             # deep-dive into auth module
```

### /release
Creates a release with version bump, changelog, and git tag.

```
/release patch                    # bump patch version
/release minor                    # bump minor version
/release major                    # bump major version
/release 2.1.0                    # explicit version
/release minor --publish github   # also create GitHub release
```

### /refactor
Plans and executes systematic refactoring.

```
/refactor "Extract auth middleware into separate module"
/refactor "Rename userService to accountService across codebase"
/refactor "Migrate callbacks to async/await in api layer"
```
