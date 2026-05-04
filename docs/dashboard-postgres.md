# Dashboard PostgreSQL Operations Guide

## Quick Start

```bash
# 1. Copy environment file and set password
cp tools/dashboard/.env.example tools/dashboard/.env
# Edit .env: set ARCHITECT_PG_PASSWORD

# 2. Start PostgreSQL and the dashboard
tools/dashboard/dashctl.sh start
# dashctl start handles docker compose up + health wait automatically

# 3. Open the dashboard
open http://127.0.0.1:3777
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `ARCHITECT_PG_HOST` | `127.0.0.1` | PostgreSQL host |
| `ARCHITECT_PG_PORT` | `5432` | PostgreSQL port (container host binding) |
| `ARCHITECT_PG_DB` | `architect` | Database name |
| `ARCHITECT_PG_USER` | `architect` | PostgreSQL user |
| `ARCHITECT_PG_PASSWORD` | *(required)* | PostgreSQL password |
| `PG_POOL_MAX` | `10` | Maximum pool connections |
| `PG_POOL_IDLE_TIMEOUT_MS` | `30000` | Idle connection timeout (ms) |
| `PG_CONNECTION_TIMEOUT_MS` | `5000` | Connection attempt timeout (ms) |
| `PG_STATEMENT_TIMEOUT_MS` | `30000` | Per-statement timeout (ms) |
| `DASHCTL_PORT` | `3777` | Dashboard HTTP port |

All `ARCHITECT_PG_*` variables are read by both `db.mjs` and `dashctl.sh`.

## Volume Location

PostgreSQL data lives in the Docker named volume `architect_pgdata`. To find it on disk:

```bash
docker volume inspect architect_pgdata
# Look for "Mountpoint" in the output
```

The volume persists across `docker compose down` (use `down -v` only when you intend to wipe all data).

## Troubleshooting

### Docker is not running

**Symptom**: `dashctl.sh start` prints `Error: Docker is not running.`

**Fix**: Start Docker Desktop, wait for the whale icon to appear in the menu bar, then retry.

---

### Port 5432 already in use

**Symptom**: `docker compose up` fails with `Bind for 127.0.0.1:5432 failed`.

**Fix**: Set a different host port in your `.env`:

```bash
ARCHITECT_PG_PORT=5433
```

Docker Compose maps this to the container's internal 5432.

---

### Wrong password / authentication failure

**Symptom**: Server log contains `PostgreSQL auth failed (28P01)`.

**Fix**: Check `ARCHITECT_PG_PASSWORD` in your `.env`. If you changed the password after the volume was created, the volume still holds the old password. Either restore the original password or run `dashctl.sh reset --confirm` (destroys all data) and set the new password before restarting.

---

### Schema drift detected

**Symptom**: Server fails to start with `Schema drift detected. Missing: ...`

**Meaning**: The database has rows in `schema_migrations` that indicate all migrations ran, but one or more expected columns are absent. This can happen if a migration was applied with a duplicate version number (W-951 class) or if the database was manually modified.

**Fix**:

1. Check `tmp/dashboard.log` for which migration was skipped.
2. Run the missing migration manually via `dashctl.sh db:psql`.
3. If the schema is unrecoverable, restore from a backup:
   ```bash
   tools/dashboard/dashctl.sh db:restore assets/backups/architect-<timestamp>.dump
   ```
4. In an emergency, bypass the check with `ARCHITECT_SKIP_SCHEMA_ASSERT=1 dashctl.sh start` and fix immediately.

---

### Data loss / accidental volume deletion

**Symptom**: `docker volume rm architect_pgdata` was run, or `docker system prune --volumes` was executed.

**Fix**: Restore from the most recent backup:

```bash
# 1. Bring up a fresh PostgreSQL (creates a new empty volume)
tools/dashboard/dashctl.sh db:up

# 2. Restore the dump
tools/dashboard/dashctl.sh db:restore assets/backups/architect-<timestamp>.dump

# 3. Start the dashboard
tools/dashboard/dashctl.sh start
```

If no backup exists, data cannot be recovered.

---

### Dashboard starts but work items are missing

**Symptom**: Dashboard loads but backlog is empty after a restart.

**Likely cause**: The server connected to a different database (check `ARCHITECT_PG_DB`), or PostgreSQL started with a fresh volume.

**Fix**: Verify the container is using the correct volume:
```bash
docker inspect architect-postgres | grep -A5 Mounts
```

## Test Isolation

Tests never touch the production `architect` database. Each test worker creates its own
PostgreSQL database named `architect_test_<port>_<timestamp>` before spawning a test server
and drops it (WITH FORCE) after teardown. This prevents cross-test pollution and allows
parallel test execution without conflicts.

The test infrastructure reads `ARCHITECT_PG_HOST`, `ARCHITECT_PG_PORT`, `ARCHITECT_PG_USER`,
and `ARCHITECT_PG_PASSWORD` from the environment — only the database name is overridden per worker.

## Backup and Restore

### Take a backup

```bash
# Writes to assets/backups/architect-<timestamp>.dump
tools/dashboard/dashctl.sh db:dump
```

The dump uses `pg_dump -Fc` (custom format), which is compressed and supports selective restore.

### Restore a backup

```bash
tools/dashboard/dashctl.sh db:restore assets/backups/architect-2026-04-30T10-00-00.dump
```

This calls `pg_restore` against the running database. For a clean restore, reset the database first:

```bash
tools/dashboard/dashctl.sh reset --confirm
tools/dashboard/dashctl.sh db:restore <file>
tools/dashboard/dashctl.sh start
```

### Automate backups

Run `db:dump` from a cron job or before any risky operation (volume reset, major migration):

```bash
# Example: daily backup at 02:00
0 2 * * * cd /path/to/architect && tools/dashboard/dashctl.sh db:dump
```
