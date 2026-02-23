---
name: work
description: Track work items across sessions
user_invocable: true
arguments:
  - name: subcommand
    description: "Action: add, show, update, log, list, remove (default: list open+in-progress)"
    required: false
  - name: args
    description: "Arguments for the subcommand (title, ID, status, message, filters)"
    required: false
---

# /work

Persistent work item tracking across sessions.

## Steps

Follow `usecases/track-work.md` with:
- subcommand from `$ARGUMENTS.subcommand` (default: list)
- args from `$ARGUMENTS.args`

See `domain/entities.md` → WorkItem, WorkBacklog for data schemas.
See `domain/rules.md` → Work Item Rules for ID format and status rules.

## Usage

```
/work                                          Show open + in-progress items
/work add "Migrate state management"           Create with defaults
/work add "Add rate limiting" --project neuronic/cloud/main --priority high --tags api,feature
/work show W-001                               Full detail + session log
/work update W-001 in-progress                 Change status
/work log W-001 "Completed investigation phase"  Append log entry
/work list --status blocked                    Filter by status
/work list --project neuronic/light-app/main   Filter by project
/work list --tag refactor                      Filter by tag
/work remove W-001                             Delete (with confirmation)
```
