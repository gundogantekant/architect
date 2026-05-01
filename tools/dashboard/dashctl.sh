#!/usr/bin/env bash
set -euo pipefail

# --- Resolve project root (portable, no readlink -f) ---
resolve_path() {
  local target="$1"
  cd "$(dirname "$target")" 2>/dev/null || return 1
  target="$(basename "$target")"
  while [ -L "$target" ]; do
    target="$(readlink "$target")"
    cd "$(dirname "$target")" 2>/dev/null || return 1
    target="$(basename "$target")"
  done
  echo "$(pwd -P)/$target"
}

SCRIPT_PATH="$(resolve_path "${BASH_SOURCE[0]}")"
DASHBOARD_DIR="$(dirname "$SCRIPT_PATH")"
ROOT="$(cd "$DASHBOARD_DIR/../.." && pwd -P)"

SERVER_SCRIPT="$DASHBOARD_DIR/server.mjs"
PORT="${DASHCTL_PORT:-3777}"
PID_FILE="${DASHCTL_PID_FILE:-$ROOT/tmp/dashboard.pid}"
LOG_FILE="${DASHCTL_LOG_FILE:-$ROOT/tmp/dashboard.log}"
SESSIONS_FILE="$ROOT/work/sessions.json"
COMPOSE_FILE="$DASHBOARD_DIR/docker-compose.yml"
PG_USER="${ARCHITECT_PG_USER:-architect}"
PG_DB="${ARCHITECT_PG_DB:-architect}"
PG_HOST="${ARCHITECT_PG_HOST:-127.0.0.1}"
PG_PORT="${ARCHITECT_PG_PORT:-3778}"

# Service identifiers
LAUNCHD_LABEL="com.architect.dashboard"
LAUNCHD_PLIST="${DASHCTL_LAUNCHD_PLIST:-$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist}"
SYSTEMD_SERVICE="architect-dashboard"
SYSTEMD_UNIT="$HOME/.config/systemd/user/${SYSTEMD_SERVICE}.service"

# --- Helpers ---

ensure_tmp() {
  mkdir -p "$ROOT/tmp"
}

is_dashboard_process() {
  local pid="$1"
  local cmd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)" || return 1
  [[ "$cmd" == *node* && "$cmd" == *server.mjs* ]]
}

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null)" || return 1
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE"
    return 1
  fi
  if kill -0 "$pid" 2>/dev/null; then
    # PID is alive — verify it's actually the dashboard, not a recycled PID
    if is_dashboard_process "$pid"; then
      return 0
    else
      # PID was recycled to a different process — stale
      rm -f "$PID_FILE"
      return 1
    fi
  else
    # Process is dead — stale PID file
    rm -f "$PID_FILE"
    return 1
  fi
}

get_pid() {
  cat "$PID_FILE" 2>/dev/null || echo ""
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -tlnp "sport = :$PORT" 2>/dev/null | grep -q ":$PORT"
  else
    return 1
  fi
}

get_port_pid() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$PORT" -sTCP:LISTEN -P -n -t 2>/dev/null | head -1
  fi
}

health_check() {
  curl -sf "http://127.0.0.1:$PORT/api/server/status" >/dev/null 2>&1
}

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
  elif [ -x /opt/homebrew/bin/node ]; then
    echo /opt/homebrew/bin/node
  elif [ -x /usr/local/bin/node ]; then
    echo /usr/local/bin/node
  else
    echo "node"
  fi
}

detect_service() {
  if [ -f "$LAUNCHD_PLIST" ]; then
    echo "launchd"
  elif [ -f "$SYSTEMD_UNIT" ]; then
    echo "systemd"
  else
    echo "none"
  fi
}

# --- Commands ---

ensure_postgres() {
  if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker is not running. Start Docker Desktop and retry."
    exit 1
  fi

  docker compose -f "$COMPOSE_FILE" up -d postgres

  echo "Waiting for PostgreSQL..."
  local i=1
  while [ "$i" -le 30 ]; do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres \
        pg_isready -U "$PG_USER" -d "$PG_DB" > /dev/null 2>&1; then
      echo "PostgreSQL ready."
      return 0
    fi
    if [ "$i" -eq 30 ]; then
      echo "Error: PostgreSQL did not become ready within 30 seconds."
      exit 1
    fi
    sleep 1
    i=$((i + 1))
  done
}

cmd_start() {
  ensure_tmp

  if docker info >/dev/null 2>&1 && [ "$PG_PORT" != "5432" ]; then
    local existing_host_port
    existing_host_port="$(docker inspect --format '{{range $p,$conf := .NetworkSettings.Ports}}{{if eq $p "5432/tcp"}}{{(index $conf 0).HostPort}}{{end}}{{end}}' architect-postgres 2>/dev/null || echo '')"
    if [ "$existing_host_port" = "5432" ]; then
      echo "Warning: PostgreSQL container found on port 5432 (old default)."
      echo "  Set ARCHITECT_PG_PORT=5432 in your environment to keep using it,"
      echo "  or run 'dashctl.sh db:down' first to let docker compose recreate it on port $PG_PORT."
    fi
  fi

  ensure_postgres

  if is_running; then
    echo "Dashboard already running (PID $(get_pid))"
    return 0
  fi

  if port_in_use; then
    local port_pid
    port_pid="$(get_port_pid)"
    if [ -n "$port_pid" ]; then
      echo "Port $PORT is already in use by PID $port_pid"
    else
      echo "Port $PORT is already in use"
    fi
    echo "Run 'dashctl.sh stop' to stop it first"
    return 1
  fi

  local NODE_BIN
  NODE_BIN="$(find_node)"

  # Auto-install production dependencies if pg is absent
  local NPM_BIN
  NPM_BIN="$(command -v npm 2>/dev/null || echo "$(dirname "$NODE_BIN")/npm")"
  if [ ! -d "$DASHBOARD_DIR/node_modules/pg" ]; then
    echo "Installing dashboard dependencies (first run or after migration)..."
    if ! "$NPM_BIN" ci --omit=dev --prefer-offline --prefix "$DASHBOARD_DIR" >> "$LOG_FILE" 2>&1; then
      echo "Error: Failed to install dashboard dependencies. Check logs:"
      echo "  $LOG_FILE"
      return 1
    fi
    echo "Dependencies installed."
  fi

  echo "Starting dashboard server..."
  nohup "$NODE_BIN" "$SERVER_SCRIPT" --port "$PORT" >> "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  # Wait up to 5 seconds for the server to be ready
  local tries=0
  while [ $tries -lt 10 ]; do
    if health_check; then
      echo "Dashboard running at http://127.0.0.1:$PORT (PID $pid)"
      return 0
    fi
    # Check if process is still alive
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "Server process exited unexpectedly. Check logs:"
      echo "  $LOG_FILE"
      rm -f "$PID_FILE"
      return 1
    fi
    sleep 0.5
    tries=$((tries + 1))
  done

  echo "Dashboard started (PID $pid) but health check not responding yet"
  echo "  URL: http://127.0.0.1:$PORT"
  echo "  Log: $LOG_FILE"
}

_stop_postgres() {
  if docker info >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" stop postgres 2>/dev/null || true
    echo "PostgreSQL stopped."
  fi
}

cmd_stop() {
  local exit_code=0

  if is_running; then
    local pid
    pid="$(get_pid)"
    echo "Stopping dashboard (PID $pid)..."

    kill "$pid" 2>/dev/null || true

    local tries=0
    while [ $tries -lt 20 ]; do
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "Dashboard stopped"
        break
      fi
      sleep 0.5
      tries=$((tries + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
      echo "Graceful shutdown timed out, sending SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "Dashboard killed"
    fi

  else
    local service
    service="$(detect_service)"

    if [ "$service" = "launchd" ] && port_in_use; then
      echo "Stopping launchd service ($LAUNCHD_LABEL)..."
      launchctl stop "$LAUNCHD_LABEL" 2>/dev/null || true
      local tries=0
      while [ $tries -lt 20 ]; do
        if ! port_in_use; then
          echo "Dashboard stopped"
          break
        fi
        sleep 0.5
        tries=$((tries + 1))
      done
      if port_in_use; then
        echo "Warning: port $PORT still in use after service stop"
        exit_code=1
      fi

    elif [ "$service" = "systemd" ] && port_in_use; then
      echo "Stopping systemd service ($SYSTEMD_SERVICE)..."
      systemctl --user stop "$SYSTEMD_SERVICE" 2>/dev/null || true
      echo "Dashboard stopped"

    else
      if port_in_use; then
        local orphan_pid
        orphan_pid="$(get_port_pid)"
        if [ -n "$orphan_pid" ]; then
          echo "Stopping orphaned dashboard process (PID $orphan_pid)..."
          kill "$orphan_pid" 2>/dev/null || true
          local tries=0
          while [ $tries -lt 20 ]; do
            if ! port_in_use; then
              echo "Dashboard stopped"
              break
            fi
            sleep 0.5
            tries=$((tries + 1))
          done
          if port_in_use; then
            kill -9 "$orphan_pid" 2>/dev/null || true
            echo "Dashboard killed"
          fi
        else
          echo "Port $PORT is in use but could not identify the process"
        fi
      else
        echo "Dashboard is not running"
      fi
    fi
  fi

  _stop_postgres
  return $exit_code
}

cmd_restart() {
  cmd_stop
  local tries=0
  while port_in_use && [ $tries -lt 10 ]; do
    sleep 0.5
    tries=$((tries + 1))
  done
  cmd_start
}

cmd_status() {
  local service
  service="$(detect_service)"

  echo "Dashboard Status"
  echo "================"

  if is_running; then
    local pid
    pid="$(get_pid)"
    echo "  Status:  Running"
    echo "  PID:     $pid"
    echo "  Port:    $PORT"
    echo "  URL:     http://127.0.0.1:$PORT"

    # Uptime from /proc or ps
    if [ -d "/proc/$pid" ]; then
      local start_time
      start_time=$(stat -c %Y "/proc/$pid" 2>/dev/null || echo "")
      if [ -n "$start_time" ]; then
        local now
        now=$(date +%s)
        local uptime=$((now - start_time))
        echo "  Uptime:  ${uptime}s"
      fi
    elif command -v ps >/dev/null 2>&1; then
      local etime
      etime=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)
      if [ -n "$etime" ]; then
        echo "  Uptime:  $etime"
      fi
    fi

    if health_check; then
      echo "  Health:  OK"
    else
      echo "  Health:  Not responding"
    fi
  elif port_in_use; then
    echo "  Status:  Port $PORT in use (external process)"
    if health_check; then
      echo "  Health:  OK (server responding)"
    fi
  else
    echo "  Status:  Stopped"
  fi

  echo ""
  echo "  Service: $service"
  if [ "$service" = "launchd" ]; then
    echo "  Config:  $LAUNCHD_PLIST"
  elif [ "$service" = "systemd" ]; then
    echo "  Config:  $SYSTEMD_UNIT"
  fi
  echo "  Log:     $LOG_FILE"
  echo "  PID file: $PID_FILE"

  echo ""
  echo "  Database:"
  echo "  PG Port:   127.0.0.1:${PG_PORT}"
  echo "  PG DB:     ${PG_DB}"
  echo "  Data vol:  architect_pgdata"
  if docker info >/dev/null 2>&1; then
    local pg_running
    pg_running="$(docker compose -f "$COMPOSE_FILE" ps --status running postgres 2>/dev/null | grep -c postgres || echo 0)"
    if [ "${pg_running:-0}" -gt 0 ] 2>/dev/null; then
      echo "  PG Status: Running"
    else
      echo "  PG Status: Stopped"
    fi
    local vol_path
    vol_path="$(docker volume inspect architect_pgdata --format '{{.Mountpoint}}' 2>/dev/null || echo 'volume not found')"
    local os_note=""
    if [ "$(uname -s)" = "Darwin" ]; then
      os_note=" (Docker Desktop VM path)"
    fi
    echo "  Data path: $vol_path$os_note"
  else
    echo "  PG Status: Docker not running"
  fi
}

cmd_logs() {
  local lines=50
  local follow=false

  while [ $# -gt 0 ]; do
    case "$1" in
      -n) shift; lines="${1:-50}" ;;
      -f) follow=true ;;
      *) ;;
    esac
    shift
  done

  if [ ! -f "$LOG_FILE" ]; then
    echo "No log file found at $LOG_FILE"
    return 1
  fi

  if [ "$follow" = true ]; then
    tail -n "$lines" -f "$LOG_FILE"
  else
    tail -n "$lines" "$LOG_FILE"
  fi
}

cmd_fresh() {
  local clear_sessions=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --clear-sessions) clear_sessions=true ;;
      *) ;;
    esac
    shift
  done

  cmd_stop

  if [ "$clear_sessions" = true ]; then
    if [ -f "$SESSIONS_FILE" ]; then
      rm -f "$SESSIONS_FILE"
      echo "Cleared sessions.json"
    fi
  fi

  sleep 1
  cmd_start
}

cmd_install() {
  local os
  os="$(uname -s)"

  if [ "$os" = "Darwin" ]; then
    install_launchd
  elif [ "$os" = "Linux" ]; then
    install_systemd
  else
    echo "Unsupported OS: $os"
    return 1
  fi
}

install_launchd() {
  local NODE_BIN
  NODE_BIN="$(find_node)"

  mkdir -p "$(dirname "$LAUNCHD_PLIST")"

  cat > "$LAUNCHD_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVER_SCRIPT}</string>
    <string>--port</string>
    <string>${PORT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
PLIST

  if [ -n "${PORTFOLIO_DIR:-}" ]; then
    # Inject PORTFOLIO_DIR into the plist EnvironmentVariables dict before closing </dict>
    sed -i '' 's|    <key>PATH</key>|    <key>PATH</key>|' "$LAUNCHD_PLIST"
    python3 -c "
import plistlib, sys
with open('$LAUNCHD_PLIST', 'rb') as f: p = plistlib.load(f)
p.setdefault('EnvironmentVariables', {})['PORTFOLIO_DIR'] = '${PORTFOLIO_DIR}'
with open('$LAUNCHD_PLIST', 'wb') as f: plistlib.dump(p, f)
" 2>/dev/null || true
  fi

  # Load the service
  launchctl load -w "$LAUNCHD_PLIST" 2>/dev/null || true

  echo "Installed launchd service: $LAUNCHD_LABEL"
  echo "  Plist: $LAUNCHD_PLIST"
  echo "  The dashboard will start automatically on login"
  echo "  To start now: launchctl start $LAUNCHD_LABEL"
}

install_systemd() {
  local NODE_BIN
  NODE_BIN="$(find_node)"

  mkdir -p "$(dirname "$SYSTEMD_UNIT")"

  cat > "$SYSTEMD_UNIT" <<UNIT
[Unit]
Description=Architect Dashboard Server
After=network.target

[Service]
Type=simple
ExecStart=${NODE_BIN} ${SERVER_SCRIPT} --port ${PORT}
WorkingDirectory=${ROOT}
Restart=on-failure
RestartSec=10
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
UNIT

  if [ -n "${PORTFOLIO_DIR:-}" ]; then
    echo "Environment=PORTFOLIO_DIR=${PORTFOLIO_DIR}" >> "$SYSTEMD_UNIT"
  fi

  cat >> "$SYSTEMD_UNIT" <<UNIT

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable "$SYSTEMD_SERVICE"

  echo "Installed systemd user service: $SYSTEMD_SERVICE"
  echo "  Unit: $SYSTEMD_UNIT"
  echo "  The dashboard will start automatically on login"
  echo "  To start now: systemctl --user start $SYSTEMD_SERVICE"
}

cmd_uninstall() {
  local service
  service="$(detect_service)"

  case "$service" in
    launchd)
      launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
      rm -f "$LAUNCHD_PLIST"
      echo "Removed launchd service"
      ;;
    systemd)
      systemctl --user disable "$SYSTEMD_SERVICE" 2>/dev/null || true
      systemctl --user stop "$SYSTEMD_SERVICE" 2>/dev/null || true
      rm -f "$SYSTEMD_UNIT"
      systemctl --user daemon-reload
      echo "Removed systemd user service"
      ;;
    none)
      echo "No auto-start service installed"
      ;;
  esac
}

cmd_sync_install() {
  local plist_name="com.architect.repo-sync"
  local plist_src="$DASHBOARD_DIR/../repo-sync/com.architect.repo-sync.plist"
  local plist_dst="$HOME/Library/LaunchAgents/${plist_name}.plist"
  local node_bin
  node_bin=$(find_node)

  if [ -z "$node_bin" ]; then
    echo "node not found; install Node.js first" >&2
    exit 1
  fi

  # Substitute placeholders
  sed -e "s|NODE_BINARY_PLACEHOLDER|${node_bin}|g" \
      -e "s|ARCHITECT_ROOT_PLACEHOLDER|${ROOT}|g" \
      "$plist_src" > "$plist_dst"

  launchctl load "$plist_dst"
  echo "Installed and loaded ${plist_name}"
}

cmd_sync_uninstall() {
  local plist_name="com.architect.repo-sync"
  local plist_dst="$HOME/Library/LaunchAgents/${plist_name}.plist"

  if [ -f "$plist_dst" ]; then
    launchctl unload "$plist_dst" 2>/dev/null || true
    rm "$plist_dst"
    echo "Unloaded and removed ${plist_name}"
  else
    echo "${plist_name} is not installed"
  fi
}

cmd_reset() {
  local confirm=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm) confirm=true ;;
      *) ;;
    esac
    shift
  done

  echo "WARNING: This will DESTROY ALL DATA in the PostgreSQL volume (architect_pgdata)."
  echo "         Take a backup first: dashctl.sh db:dump"

  if [ "$confirm" = false ]; then
    echo "Pass --confirm to proceed. Aborted."
    exit 1
  fi

  cmd_stop
  cmd_db_reset_confirmed
  echo "Database wiped. Run './dashctl.sh start' to restart with a fresh database."
}

cmd_db_up() {
  if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker is not running. Start Docker Desktop and retry."
    exit 1
  fi
  docker compose -f "$COMPOSE_FILE" up -d postgres
  echo "PostgreSQL started."
}

cmd_db_down() {
  docker compose -f "$COMPOSE_FILE" down
  echo "PostgreSQL stopped. Data volume preserved."
}

cmd_db_logs() {
  docker compose -f "$COMPOSE_FILE" logs -f postgres
}

cmd_db_psql() {
  docker compose -f "$COMPOSE_FILE" exec postgres psql -U "$PG_USER" "$PG_DB"
}

cmd_db_dump() {
  local BACKUP_DIR="$ROOT/assets/backups"
  mkdir -p "$BACKUP_DIR"
  local TIMESTAMP
  TIMESTAMP="$(date -u +%Y-%m-%dT%H-%M-%S)"
  local DEST="$BACKUP_DIR/architect-${TIMESTAMP}.dump"

  local PG_PASSWORD="${ARCHITECT_PG_PASSWORD:-}"
  local args=(-h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -Fc -f "$DEST" "$PG_DB")

  echo "Dumping $PG_DB to $DEST..."
  if [ -n "$PG_PASSWORD" ]; then
    PGPASSWORD="$PG_PASSWORD" pg_dump "${args[@]}"
  else
    pg_dump "${args[@]}"
  fi
  echo "Backup complete: $DEST"
}

cmd_db_restore() {
  local FILE="${1:-}"
  if [ -z "$FILE" ]; then
    echo "Usage: dashctl.sh db:restore <file>"
    exit 1
  fi
  if [ ! -f "$FILE" ]; then
    echo "Error: file not found: $FILE"
    exit 1
  fi

  local PG_PASSWORD="${ARCHITECT_PG_PASSWORD:-}"
  local args=(-h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DB" "$FILE")

  echo "Restoring $FILE into $PG_DB..."
  if [ -n "$PG_PASSWORD" ]; then
    PGPASSWORD="$PG_PASSWORD" pg_restore "${args[@]}"
  else
    pg_restore "${args[@]}"
  fi
  echo "Restore complete."
}

cmd_db_reset_confirmed() {
  if ! docker info > /dev/null 2>&1; then
    echo "Error: Docker is not running. Start Docker Desktop and retry."
    exit 1
  fi
  docker compose -f "$COMPOSE_FILE" down -v
  docker compose -f "$COMPOSE_FILE" up -d postgres

  echo "Waiting for fresh PostgreSQL..."
  local i=1
  while [ "$i" -le 30 ]; do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres \
        pg_isready -U "$PG_USER" -d "$PG_DB" > /dev/null 2>&1; then
      echo "PostgreSQL ready."
      return 0
    fi
    if [ "$i" -eq 30 ]; then
      echo "Error: PostgreSQL did not become ready within 30 seconds."
      exit 1
    fi
    sleep 1
    i=$((i + 1))
  done
}

cmd_help() {
  cat <<HELP
dashctl.sh — Architect Dashboard lifecycle manager

Usage: dashctl.sh <command> [options]

Commands:
  start                Start PostgreSQL (if not running) then the dashboard server
  stop                 Stop the dashboard server and PostgreSQL container gracefully
  restart              Restart dashboard and PostgreSQL (full cycle, adds ~5–30s for postgres startup)
  status               Show server status, PID, port, uptime
  logs [-n N] [-f]     Tail the log file (default: last 50 lines)
  fresh [--clear-sessions]  Stop, optionally clear sessions, start
  reset [--confirm]    DESTROY ALL DATA: wipe PostgreSQL volume and restart with empty DB
  install              Install auto-start service (launchd/systemd)
  uninstall            Remove auto-start service
  sync-install         Install repo-sync launchd agent (runs at 08:00 and 20:00)
  sync-uninstall       Remove repo-sync launchd agent
  help                 Show this help

Database commands:
  db:up                Start PostgreSQL container only
  db:down              Stop PostgreSQL container only, keeping dashboard server running (data volume preserved)
  db:logs              Follow PostgreSQL container logs
  db:psql              Open psql shell in the running PostgreSQL container
  db:dump              Dump the database to assets/backups/ with a timestamp
  db:restore <file>    Restore a dump file into the current database
  db:reset             Alias for 'reset' (requires --confirm)

Environment:
  Root:     $ROOT
  Server:   $SERVER_SCRIPT
  PID file: $PID_FILE
  Log file: $LOG_FILE
  Port:     $PORT
  PG host:  $PG_HOST
  PG port:  $PG_PORT
  PG user:  $PG_USER
  PG DB:    $PG_DB
  Data vol: architect_pgdata
HELP
}

# --- Main dispatch ---
case "${1:-help}" in
  start)       cmd_start ;;
  stop)        cmd_stop ;;
  restart)     cmd_restart ;;
  status)      cmd_status ;;
  logs)        shift; cmd_logs "$@" ;;
  fresh)       shift; cmd_fresh "$@" ;;
  reset)       shift; cmd_reset "$@" ;;
  install)          cmd_install ;;
  uninstall)        cmd_uninstall ;;
  sync-install)     cmd_sync_install ;;
  sync-uninstall)   cmd_sync_uninstall ;;
  db:up)       cmd_db_up ;;
  db:down)     cmd_db_down ;;
  db:logs)     cmd_db_logs ;;
  db:psql)     cmd_db_psql ;;
  db:dump)     cmd_db_dump ;;
  db:restore)  shift; cmd_db_restore "$@" ;;
  db:reset)    shift; cmd_reset "$@" ;;
  help|--help|-h) cmd_help ;;
  *)
    echo "Unknown command: $1"
    echo "Run 'dashctl.sh help' for usage"
    exit 1
    ;;
esac
