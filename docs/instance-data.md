# Instance Data

`portfolio/` and `work/` are gitignored directories containing local instance data. A fresh clone will not have them.

## portfolio/

Created by `/onboard <path>`. Contains project profiles, organization configs, and a registry mapping paths to portfolio locations.

Structure: `portfolio/<org>/<project>/<component>.json`

Bootstrap: run `/onboard <path>` for each project you want to register.

## work/

Created by `/work add`. Contains `backlog.json` with cross-session work items keyed by project.

Bootstrap: the tracker agent creates `work/backlog.json` automatically on first use.

## Backup

These directories contain non-recoverable local data. Back them up if needed before destructive git operations.
