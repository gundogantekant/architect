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

cmd_start() {
  ensure_tmp

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

cmd_stop() {
  if is_running; then
    local pid
    pid="$(get_pid)"
    echo "Stopping dashboard (PID $pid)..."

    kill "$pid" 2>/dev/null || true

    # Wait up to 10 seconds for graceful shutdown
    local tries=0
    while [ $tries -lt 20 ]; do
      if ! kill -0 "$pid" 2>/dev/null; then
        rm -f "$PID_FILE"
        echo "Dashboard stopped"
        return 0
      fi
      sleep 0.5
      tries=$((tries + 1))
    done

    # Force kill
    echo "Graceful shutdown timed out, sending SIGKILL..."
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Dashboard killed"
    return 0
  fi

  # Not managed via PID file — check if a service owns the port
  local service
  service="$(detect_service)"

  if [ "$service" = "launchd" ] && port_in_use; then
    echo "Stopping launchd service ($LAUNCHD_LABEL)..."
    launchctl stop "$LAUNCHD_LABEL" 2>/dev/null || true
    local tries=0
    while [ $tries -lt 20 ]; do
      if ! port_in_use; then
        echo "Dashboard stopped"
        return 0
      fi
      sleep 0.5
      tries=$((tries + 1))
    done
    echo "Warning: port $PORT still in use after service stop"
    return 1

  elif [ "$service" = "systemd" ] && port_in_use; then
    echo "Stopping systemd service ($SYSTEMD_SERVICE)..."
    systemctl --user stop "$SYSTEMD_SERVICE" 2>/dev/null || true
    echo "Dashboard stopped"
    return 0

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
            return 0
          fi
          sleep 0.5
          tries=$((tries + 1))
        done
        kill -9 "$orphan_pid" 2>/dev/null || true
        echo "Dashboard killed"
      else
        echo "Port $PORT is in use but could not identify the process"
      fi
    else
      echo "Dashboard is not running"
    fi
    return 0
  fi
}

cmd_restart() {
  cmd_stop
  sleep 1
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

cmd_reset() {
  local confirm=false

  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm) confirm=true ;;
      *) ;;
    esac
    shift
  done

  local DB_FILE="$ROOT/work/architect.db"

  echo "WARNING: This will permanently delete the dashboard database."

  if [ "$confirm" = false ]; then
    printf "Type 'yes' to confirm: "
    read -r user_input
    if [ "$user_input" != "yes" ]; then
      echo "Aborted."
      exit 1
    fi
  fi

  cmd_stop

  if [ -f "$DB_FILE" ]; then
    rm -f "$DB_FILE"
  fi

  echo "Database wiped. Run './dashctl.sh start' to restart with a fresh database."
}

cmd_help() {
  cat <<HELP
dashctl.sh — Architect Dashboard lifecycle manager

Usage: dashctl.sh <command> [options]

Commands:
  start                Start the dashboard server in background
  stop                 Stop the dashboard server gracefully
  restart              Restart the server (service-aware: uses launchctl/systemctl when installed)
  status               Show server status, PID, port, uptime
  logs [-n N] [-f]     Tail the log file (default: last 50 lines)
  fresh [--clear-sessions]  Stop, optionally clear sessions, start
  reset [--confirm]    Wipe the dashboard database (keeps logs and work files)
  install              Install auto-start service (launchd/systemd)
  uninstall            Remove auto-start service
  help                 Show this help

Environment:
  Root:     $ROOT
  Server:   $SERVER_SCRIPT
  PID file: $PID_FILE
  Log file: $LOG_FILE
  Port:     $PORT
HELP
}

# --- Main dispatch ---
case "${1:-help}" in
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  restart)   cmd_restart ;;
  status)    cmd_status ;;
  logs)      shift; cmd_logs "$@" ;;
  fresh)     shift; cmd_fresh "$@" ;;
  reset)     shift; cmd_reset "$@" ;;
  install)   cmd_install ;;
  uninstall) cmd_uninstall ;;
  help|--help|-h) cmd_help ;;
  *)
    echo "Unknown command: $1"
    echo "Run 'dashctl.sh help' for usage"
    exit 1
    ;;
esac
