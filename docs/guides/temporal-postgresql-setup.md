# Temporal PostgreSQL Setup Guide

**Scope**: Setting up the existing Docker PostgreSQL instance as Temporal's persistence backend with per-namespace schema isolation.

**Related tickets**: W-1207 (PoC spike), W-1208 (chat dashboard), W-1209 (per-session orchestrator), W-1210 (this setup).

---

## Architecture overview

Temporal requires two persistence stores per server instance:
- **defaultStore** (`_temporal` schemas) — workflow history, task queues, timers
- **visibilityStore** (`_temporal_visibility` schemas) — search-optimised workflow query index

Each project namespace gets its own schema pair within the shared Docker PostgreSQL database, avoiding changes to the existing `public` (dashboard tables) and `ai_chat` (chat feature) schemas.

```
PostgreSQL database: architect
├── public                       ← dashboard tables (untouched)
├── ai_chat                      ← chat feature (untouched)
├── architect_temporal           ← namespace: architect
├── architect_temporal_visibility
├── neuronic_temporal            ← namespace: neuronic-ai-team
├── neuronic_temporal_visibility
├── new_project_temporal         ← namespace: new-project (placeholder)
└── new_project_temporal_visibility
```

**Namespace-to-schema mapping:**

| Temporal namespace | Schema pair |
|---|---|
| `architect` | `architect_temporal`, `architect_temporal_visibility` |
| `neuronic-ai-team` | `neuronic_temporal`, `neuronic_temporal_visibility` |
| `new-project` | `new_project_temporal`, `new_project_temporal_visibility` |
| `--namespace my-app` | `my_app_temporal`, `my_app_temporal_visibility` |

In the single-server development setup, all three namespaces share the `architect_temporal` defaultStore — Temporal handles namespace isolation at the application level. The `neuronic_temporal` and `new_project_temporal` schema pairs are pre-created for future separate server instances per project (production isolation model).

---

## Prerequisites

1. **Docker PostgreSQL running** (started by the architect dashboard):
   ```bash
   ./tools/dashboard/dashctl.sh status
   # if not running:
   docker compose -f tools/dashboard/docker-compose.yml up -d
   ```

2. **`temporal-sql-tool`** for schema migrations:
   ```bash
   brew install temporal   # includes temporal-sql-tool
   ```
   Or download from [temporalio/temporal releases](https://github.com/temporalio/temporal/releases) and add `temporal-sql-tool` to your PATH.

3. **Credentials file** (one-time setup):
   ```bash
   cp tools/temporal/config/.env.example tools/temporal/config/.env
   # .env is gitignored — edit it and set ARCHITECT_PG_PASSWORD
   ```
   The default password for the local Docker Postgres is set in `tools/dashboard/.env`. If the dashboard is working, use the same value.

---

## Local setup

### Step 1 — Create schemas and run migrations

```bash
./tools/temporal/setup.sh
```

This script:
1. Checks PostgreSQL connectivity (exits with instructions if not running)
2. Checks `temporal-sql-tool` is installed (exits with install instructions if not)
3. Creates the six schema pairs (idempotent — safe to re-run)
4. Runs `temporal-sql-tool create-initial-schema` for each schema (skips if already migrated)
5. Registers namespaces in a running Temporal server (or prints instructions if server not running)

### Step 2 — Start the Temporal server

```bash
source tools/temporal/config/.env

# Option A: full server with PostgreSQL persistence (recommended for dev + production)
temporal server start --config tools/temporal/config --env development \
  --namespace architect \
  --namespace neuronic-ai-team \
  --namespace new-project

# Option B: dev mode with PostgreSQL config (newer temporal CLI v1.0+)
temporal server start-dev \
  --config tools/temporal/config/development.yaml \
  --namespace architect \
  --namespace neuronic-ai-team \
  --namespace new-project
```

The `--namespace` flags pre-register namespaces on server start, complementing the registration that `setup.sh` attempts while the server is running.

### Step 3 — Verify

```bash
# All three should return an empty list (not an error)
temporal workflow list --namespace architect
temporal workflow list --namespace neuronic-ai-team
temporal workflow list --namespace new-project

# Or list all registered namespaces
temporal operator namespace list
```

The Temporal Web UI is available at `http://localhost:8233`.

---

## Adding a new project namespace

Run `setup.sh` with `--namespace` — no script editing required:

```bash
./tools/temporal/setup.sh --namespace my-new-project
```

This creates `my_new_project_temporal` and `my_new_project_temporal_visibility` in PostgreSQL, runs migrations, and registers the namespace if the Temporal server is running.

To make it permanent in the default list, add the namespace name and its schema prefix to `setup.sh`'s `schema_prefix` function and `ALL_NAMESPACES` array. See the comments at the top of the script.

---

## Idempotency

`setup.sh` is safe to re-run at any time. Each operation is guarded:

| Operation | Idempotency mechanism |
|---|---|
| Schema creation | `CREATE SCHEMA IF NOT EXISTS` |
| Main schema migration | Checks for `executions` table before running |
| Visibility schema migration | Checks for `executions_visibility` table before running |
| Namespace registration | `temporal operator namespace describe` before `create` |

---

## Schema naming convention

For `--namespace` additions, non-alphanumeric characters are replaced with underscores:
- `my-project` → `my_project_temporal`
- `team.platform` → `team_platform_temporal`

The three hardcoded defaults use custom short prefixes (`neuronic` for `neuronic-ai-team`, `new_project` for `new-project`) to keep schema names readable.

---

## Two-phase setup note

Schema creation and migrations (Step 1) do not require a running Temporal server. Namespace registration (Step 1, final phase) does require the server to be running. If you run `setup.sh` before the server is started, registration is deferred:

```
⚠  could not register 'architect' — server not reachable at 127.0.0.1:7233
   Run after starting the server:
     temporal --address 127.0.0.1:7233 operator namespace create architect --retention 30d
```

Re-running `setup.sh` after starting the server completes registration. Alternatively, using `--namespace` flags on `temporal server start` registers namespaces automatically.

---

## `temporal-sql-tool` version notes

The `--schema-name` flag (for PostgreSQL schema-level isolation within one database) was introduced in temporal-sql-tool bundled with Temporal server v1.20+. If you see an error about an unrecognised flag, upgrade:

```bash
brew upgrade temporal
```

Both the main and visibility schemas use `create-initial-schema`. The tool creates the appropriate table set based on the schema type inferred from the schema name suffix (`_temporal` vs `_temporal_visibility`).

---

## Production migration path

The local setup described here uses a single Temporal server instance with all namespaces sharing one persistence store. For production:

1. **Separate server per project**: spin up a dedicated Temporal server pointing to each namespace's schema pair (e.g., `architect_temporal` for the architect project).
2. **Schema-per-server config**: create a separate YAML config (e.g., `neuronic.yaml`) derived from `development.yaml`, changing `schemaName` to `neuronic_temporal` and `neuronic_temporal_visibility`.
3. **Connection pooling**: adjust `maxConns` / `maxIdleConns` based on expected load.
4. **TLS**: set `tls.enabled: true` and provide certificates.
5. **`numHistoryShards`**: increase from 4 (dev) to 128 or 512 depending on expected throughput.

**Important**: changing `numHistoryShards` after the database is populated requires a migration. Choose the production value before writing any workflow history.

---

## Troubleshooting

**`psql: error: connection refused`**
- The Docker Postgres container is not running. Run `docker compose -f tools/dashboard/docker-compose.yml up -d`.

**`temporal-sql-tool: command not found`**
- Not installed. See Prerequisites above.

**`ERROR: relation "executions" already exists`**
- Rare: `setup.sh` ran but the idempotency check missed an edge case (e.g., partial previous run). Check the schema state:
  ```bash
  PGPASSWORD=<pass> psql -h 127.0.0.1 -p 3778 -U architect -d architect \
    -c "\dt architect_temporal.*"
  ```
  If the tables are there, the schema is fine and Temporal will use them.

**`namespace not found` after server start**
- Namespace was not registered. Register with:
  ```bash
  temporal operator namespace create architect --retention 30d
  ```
  Or start the server with `--namespace architect` flag.
