#!/usr/bin/env bash
# tools/temporal/setup.sh
#
# Idempotent: creates Temporal PostgreSQL schemas, runs migrations, and registers
# Temporal namespaces. Safe to run multiple times — skips already-initialized schemas.
#
# Usage:
#   ./tools/temporal/setup.sh [--namespace <name>] [--help]
#
# Default namespaces: architect, neuronic-ai-team, new-project
# Use --namespace to add more without editing this file.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="$SCRIPT_DIR/config"
ENV_FILE="$CONFIG_DIR/.env"

# ── Help ──────────────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--help" ]] || [[ "${1:-}" == "-h" ]]; then
  cat <<'EOF'
Usage: ./tools/temporal/setup.sh [--namespace <name>] [--help]

Creates Temporal PostgreSQL schema pairs, runs migrations, and registers
Temporal namespaces. Idempotent: safe to run multiple times.

Options:
  --namespace <name>   Add a namespace beyond the three defaults.
                       Can be specified multiple times.
  --help, -h           Show this help message.

Default namespaces and their schema pairs:
  architect         → architect_temporal, architect_temporal_visibility
  neuronic-ai-team  → neuronic_temporal, neuronic_temporal_visibility
  new-project       → new_project_temporal, new_project_temporal_visibility

Schema naming for --namespace additions:
  Non-alphanumeric characters in <name> are replaced with underscores.
  Example: --namespace my-app  →  my_app_temporal, my_app_temporal_visibility

Required environment variables (set in config/.env or the shell):
  ARCHITECT_PG_USER      PostgreSQL user
  ARCHITECT_PG_PASSWORD  PostgreSQL password

Optional environment variables (with defaults):
  ARCHITECT_PG_HOST      PostgreSQL host     (default: 127.0.0.1)
  ARCHITECT_PG_PORT      PostgreSQL port     (default: 3778)
  ARCHITECT_PG_DB        Database name       (default: architect)
  TEMPORAL_ADDRESS       Temporal gRPC addr  (default: 127.0.0.1:7233)
EOF
  exit 0
fi

# ── Load .env ─────────────────────────────────────────────────────────────────

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
else
  echo "INFO: $ENV_FILE not found — using shell environment."
  echo "      Copy $CONFIG_DIR/.env.example to $ENV_FILE to persist credentials."
fi

# ── Connection defaults ────────────────────────────────────────────────────────

ARCHITECT_PG_HOST="${ARCHITECT_PG_HOST:-127.0.0.1}"
ARCHITECT_PG_PORT="${ARCHITECT_PG_PORT:-3778}"
ARCHITECT_PG_DB="${ARCHITECT_PG_DB:-architect}"
TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-127.0.0.1:7233}"

# Required vars — abort with a clear message if unset or empty
: "${ARCHITECT_PG_USER:?ARCHITECT_PG_USER is required. Set it in $ENV_FILE or the environment.}"
: "${ARCHITECT_PG_PASSWORD:?ARCHITECT_PG_PASSWORD is required. Set it in $ENV_FILE or the environment.}"

# ── Parse arguments ────────────────────────────────────────────────────────────

EXTRA_NAMESPACES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      [[ $# -lt 2 ]] && { echo "ERROR: --namespace requires a value" >&2; exit 1; }
      EXTRA_NAMESPACES+=("$2")
      shift 2
      ;;
    --namespace=*)
      EXTRA_NAMESPACES+=("${1#*=}")
      shift
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      echo "Run with --help for usage." >&2
      exit 1
      ;;
  esac
done

ALL_NAMESPACES=(architect neuronic-ai-team new-project ${EXTRA_NAMESPACES[@]+"${EXTRA_NAMESPACES[@]}"})

# ── Namespace → schema prefix ──────────────────────────────────────────────────

schema_prefix() {
  local NS="$1"
  case "$NS" in
    architect)        echo "architect" ;;
    neuronic-ai-team) echo "neuronic" ;;
    new-project)      echo "new_project" ;;
    *)                echo "${NS//[^a-zA-Z0-9]/_}" ;;
  esac
}

# ── Prerequisite checks ────────────────────────────────────────────────────────

echo "=== Prerequisites ==="

# Stop condition 1: PostgreSQL must be reachable
if ! PGPASSWORD="$ARCHITECT_PG_PASSWORD" psql \
    -h "$ARCHITECT_PG_HOST" -p "$ARCHITECT_PG_PORT" \
    -U "$ARCHITECT_PG_USER" -d "$ARCHITECT_PG_DB" \
    -c "SELECT 1" > /dev/null 2>&1; then
  echo ""
  echo "ERROR: PostgreSQL not reachable at $ARCHITECT_PG_HOST:$ARCHITECT_PG_PORT (db: $ARCHITECT_PG_DB)"
  echo ""
  echo "Start the Postgres container:"
  echo "  docker compose -f tools/dashboard/docker-compose.yml up -d"
  exit 1
fi
echo "✓ PostgreSQL reachable at $ARCHITECT_PG_HOST:$ARCHITECT_PG_PORT/$ARCHITECT_PG_DB"

# Stop condition 2: temporal-sql-tool must be installed
if ! command -v temporal-sql-tool > /dev/null 2>&1; then
  echo ""
  echo "ERROR: temporal-sql-tool not found in PATH."
  echo ""
  echo "Install via Homebrew:"
  echo "  brew install temporal"
  echo ""
  echo "Or download from the Temporal server release bundle:"
  echo "  https://github.com/temporalio/temporal/releases"
  echo "  Extract temporal-sql-tool from the bundle and add it to your PATH."
  echo ""
  echo "Or run via Docker (no install required):"
  echo "  docker run --rm --network host temporalio/admin-tools:latest temporal-sql-tool ..."
  exit 1
fi
echo "✓ temporal-sql-tool: $(command -v temporal-sql-tool)"

# ── Schema setup ───────────────────────────────────────────────────────────────

setup_namespace_schemas() {
  local NS="$1"
  local PREFIX
  PREFIX="$(schema_prefix "$NS")"
  local MAIN_SCHEMA="${PREFIX}_temporal"
  local VIS_SCHEMA="${PREFIX}_temporal_visibility"

  echo ""
  echo "--- $NS  →  $MAIN_SCHEMA, $VIS_SCHEMA ---"

  # Naming convention (`_temporal` suffix) ensures schemas never collide with
  # protected schemas; this guard is a defense-in-depth check against future renames.
  for PROTECTED in public ai_chat; do
    if [[ "$MAIN_SCHEMA" == "$PROTECTED" ]] || [[ "$VIS_SCHEMA" == "$PROTECTED" ]]; then
      echo "ERROR: Derived schema name '$PROTECTED' is a protected schema. Aborting." >&2
      exit 1
    fi
  done

  # Create schema pair (idempotent via IF NOT EXISTS).
  # Identifiers are double-quoted to handle edge-case names starting with digits.
  PGPASSWORD="$ARCHITECT_PG_PASSWORD" psql \
    -h "$ARCHITECT_PG_HOST" -p "$ARCHITECT_PG_PORT" \
    -U "$ARCHITECT_PG_USER" -d "$ARCHITECT_PG_DB" \
    -v ON_ERROR_STOP=1 \
    -c "CREATE SCHEMA IF NOT EXISTS \"${MAIN_SCHEMA}\";" \
    -c "CREATE SCHEMA IF NOT EXISTS \"${VIS_SCHEMA}\";" > /dev/null
  echo "  ✓ schemas created (or already exist)"

  # Idempotency guard for main schema: check for the canonical 'executions' table.
  # table_type = 'BASE TABLE' excludes views from the count.
  local MAIN_READY
  MAIN_READY=$(PGPASSWORD="$ARCHITECT_PG_PASSWORD" psql \
    -h "$ARCHITECT_PG_HOST" -p "$ARCHITECT_PG_PORT" \
    -U "$ARCHITECT_PG_USER" -d "$ARCHITECT_PG_DB" \
    -tAc "SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema = '${MAIN_SCHEMA}'
            AND table_name = 'executions'
            AND table_type = 'BASE TABLE'")

  if [[ "${MAIN_READY:-0}" -gt 0 ]]; then
    echo "  ✓ main schema already migrated — skipping"
  else
    temporal-sql-tool \
      --plugin postgres12 \
      --ep "$ARCHITECT_PG_HOST" \
      --port "$ARCHITECT_PG_PORT" \
      --u "$ARCHITECT_PG_USER" \
      --pw "$ARCHITECT_PG_PASSWORD" \
      --db "$ARCHITECT_PG_DB" \
      --schema-name "$MAIN_SCHEMA" \
      create-initial-schema
    echo "  ✓ main schema migrated"
  fi

  # Idempotency guard for visibility schema: check for 'executions_visibility'.
  local VIS_READY
  VIS_READY=$(PGPASSWORD="$ARCHITECT_PG_PASSWORD" psql \
    -h "$ARCHITECT_PG_HOST" -p "$ARCHITECT_PG_PORT" \
    -U "$ARCHITECT_PG_USER" -d "$ARCHITECT_PG_DB" \
    -tAc "SELECT COUNT(*) FROM information_schema.tables
          WHERE table_schema = '${VIS_SCHEMA}'
            AND table_name = 'executions_visibility'
            AND table_type = 'BASE TABLE'")

  if [[ "${VIS_READY:-0}" -gt 0 ]]; then
    echo "  ✓ visibility schema already migrated — skipping"
  else
    temporal-sql-tool \
      --plugin postgres12 \
      --ep "$ARCHITECT_PG_HOST" \
      --port "$ARCHITECT_PG_PORT" \
      --u "$ARCHITECT_PG_USER" \
      --pw "$ARCHITECT_PG_PASSWORD" \
      --db "$ARCHITECT_PG_DB" \
      --schema-name "$VIS_SCHEMA" \
      create-initial-schema
    echo "  ✓ visibility schema migrated"
  fi
}

# ── Namespace registration ─────────────────────────────────────────────────────

register_namespace() {
  local NS="$1"
  if temporal --address "$TEMPORAL_ADDRESS" \
      operator namespace describe "$NS" > /dev/null 2>&1; then
    echo "  ✓ already registered: $NS"
  elif temporal --address "$TEMPORAL_ADDRESS" \
      operator namespace create "$NS" \
      --retention 30d \
      --description "Temporal namespace for $NS" > /dev/null 2>&1; then
    echo "  ✓ registered: $NS"
  else
    echo "  ⚠  could not register '$NS' — server not reachable at $TEMPORAL_ADDRESS"
    echo "     Run after starting the server:"
    echo "       temporal --address $TEMPORAL_ADDRESS operator namespace create $NS --retention 30d"
  fi
}

# ── Run ────────────────────────────────────────────────────────────────────────

echo ""
echo "=== Schema setup (${#ALL_NAMESPACES[@]} namespaces) ==="
for NS in "${ALL_NAMESPACES[@]}"; do
  setup_namespace_schemas "$NS"
done

echo ""
echo "=== Namespace registration ==="
if ! command -v temporal > /dev/null 2>&1; then
  echo "⚠  temporal CLI not found — skipping namespace registration."
  echo "   Install: brew install temporal"
  echo "   Then start the server and re-run setup.sh, or register manually:"
  for NS in "${ALL_NAMESPACES[@]}"; do
    echo "     temporal --address $TEMPORAL_ADDRESS operator namespace create $NS --retention 30d"
  done
else
  for NS in "${ALL_NAMESPACES[@]}"; do
    register_namespace "$NS"
  done
fi

# ── Summary ────────────────────────────────────────────────────────────────────

echo ""
echo "=== Setup complete ==="
echo ""
echo "Schema pairs created:"
for NS in "${ALL_NAMESPACES[@]}"; do
  PREFIX="$(schema_prefix "$NS")"
  printf "  %-20s → %s_temporal, %s_temporal_visibility\n" "$NS" "$PREFIX" "$PREFIX"
done
echo ""
echo "Start Temporal server (full config with PostgreSQL persistence):"
[[ -f "$ENV_FILE" ]] && echo "  source $ENV_FILE" || echo "  # export ARCHITECT_PG_* credentials first"
echo "  temporal server start --config $CONFIG_DIR \\"
printf "    %s\n" "$(for NS in "${ALL_NAMESPACES[@]}"; do printf -- "--namespace %s " "$NS"; done)"
echo ""
echo "Verify namespaces:"
for NS in "${ALL_NAMESPACES[@]}"; do
  echo "  temporal --address $TEMPORAL_ADDRESS workflow list --namespace $NS"
done
