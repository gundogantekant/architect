# Database Strategy

## Gradations

### G0 — SQLite (archived)

Single-file, synchronous, zero external dependencies. Used from project inception through 2026-04.
WAL mode and foreign keys were enabled. Limitations: file locking under concurrent agent dispatches,
no concurrent writers. Replaced by G2 due to reliability concerns.

### G1 — SQLite Hardened (not implemented)

Evaluated option: add busy_timeout, retry on SQLITE_IOERR, staggered terminal restoration.
Rejected because the root cause investigation revealed 95% of log errors were PTY-related (not SQLite),
and the architectural upgrade to PostgreSQL was prioritized for long-term reliability.

### G2 — PostgreSQL (current)

PostgreSQL 16 via Docker Compose. Persistent named volume. True concurrent writers.
Async connection pool (max 10). Automatic migrations on startup. Hard Docker dependency.

### G3 — PostgreSQL Managed (future)

Cloud-hosted PostgreSQL. Not in scope.

## Configuration

See `tools/dashboard/.env.example` for all environment variables.

## Operations

- Start PostgreSQL: `tools/dashboard/dashctl.sh db:up`
- Connect to DB: `tools/dashboard/dashctl.sh db:psql`
- Take backup: `tools/dashboard/dashctl.sh db:dump`
- Restore backup: `tools/dashboard/dashctl.sh db:restore <file>`

## Warning

Never run `docker system prune --volumes` or `docker volume rm architect_pgdata` without first
taking a backup. The named volume contains all work items, sessions, and portfolio data.
