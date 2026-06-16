#!/usr/bin/env bash
# dashctl.sh integration tests
# Fully isolated: uses port 3788, temp PID/log files — never touches the live dashboard on 3777.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHCTL="$SCRIPT_DIR/../dashctl.sh"
SERVER="$SCRIPT_DIR/../server.mjs"
TEST_PORT=3788

PASS=0
FAIL=0

# --- Helpers ---

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    return 0
  fi
  echo "  ASSERT FAIL [$label]: expected output to contain: $needle"
  echo "  Got: $haystack"
  return 1
}

assert_not_contains() {
  local label="$1" needle="$2" haystack="$3"
  if ! echo "$haystack" | grep -qF "$needle"; then
    return 0
  fi
  echo "  ASSERT FAIL [$label]: expected output NOT to contain: $needle"
  return 1
}

assert_exit() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    return 0
  fi
  echo "  ASSERT FAIL [$label]: expected exit $expected, got $actual"
  return 1
}

assert_port_free() {
  local label="$1"
  if ! lsof -iTCP:"$TEST_PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    return 0
  fi
  echo "  ASSERT FAIL [$label]: port $TEST_PORT is still in use"
  return 1
}

assert_port_in_use() {
  local label="$1"
  if lsof -iTCP:"$TEST_PORT" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
    return 0
  fi
  echo "  ASSERT FAIL [$label]: port $TEST_PORT is not in use"
  return 1
}

wait_for_port() {
  local port="$1" tries=0
  while [ $tries -lt 20 ]; do
    if lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    tries=$((tries + 1))
  done
  echo "  Timeout waiting for port $port to open"
  return 1
}

wait_for_port_free() {
  local port="$1" tries=0
  while [ $tries -lt 20 ]; do
    if ! lsof -iTCP:"$port" -sTCP:LISTEN -P -n >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
    tries=$((tries + 1))
  done
  echo "  Timeout waiting for port $port to close"
  return 1
}

run_test() {
  local name="$1"
  local fn="$2"
  printf "  %-40s" "$name"
  local output
  if output="$("$fn" 2>&1)"; then
    echo "PASS"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    echo "$output" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
  fi
}

# Env vars passed to every dashctl invocation to ensure isolation
dashctl_env() {
  local pid_file="$1" log_file="$2"
  shift 2
  env DASHCTL_PORT="$TEST_PORT" \
      DASHCTL_PID_FILE="$pid_file" \
      DASHCTL_LOG_FILE="$log_file" \
      DASHCTL_LAUNCHD_PLIST="/tmp/dashctl-test-nonexistent.plist" \
      bash "$DASHCTL" "$@"
}

# Start an orphaned server (no PID file created by dashctl)
start_orphan() {
  local log_file="$1"
  node "$SERVER" --port "$TEST_PORT" >> "$log_file" 2>&1 &
  echo $!
}

# --- Tests ---

test_orphan_stop() {
  local pid_file log_file orphan_pid output exit_code
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  rm -f "$pid_file"  # simulate: no PID file
  trap 'rm -f "$pid_file" "$log_file"; lsof -iTCP:'"$TEST_PORT"' -sTCP:LISTEN -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null || true' RETURN

  orphan_pid="$(start_orphan "$log_file")"
  wait_for_port "$TEST_PORT"

  output="$(dashctl_env "$pid_file" "$log_file" stop 2>&1)"
  exit_code=$?

  assert_exit "exit code" 0 "$exit_code"
  assert_contains "stop message" "Stopping orphaned" "$output"
  wait_for_port_free "$TEST_PORT"
  assert_port_free "port free after stop"
}

test_orphan_stop_then_start() {
  local pid_file log_file orphan_pid output exit_code
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  rm -f "$pid_file"
  trap 'rm -f "$pid_file" "$log_file"; lsof -iTCP:'"$TEST_PORT"' -sTCP:LISTEN -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null || true' RETURN

  orphan_pid="$(start_orphan "$log_file")"
  wait_for_port "$TEST_PORT"

  # stop orphan
  dashctl_env "$pid_file" "$log_file" stop >/dev/null 2>&1
  wait_for_port_free "$TEST_PORT"

  # start fresh via dashctl
  output="$(dashctl_env "$pid_file" "$log_file" start 2>&1)"
  exit_code=$?

  assert_exit "start exit code" 0 "$exit_code"
  assert_port_in_use "port in use after start"
  [ -f "$pid_file" ] || { echo "  ASSERT FAIL: PID file not created"; return 1; }

  # stop cleanly
  dashctl_env "$pid_file" "$log_file" stop >/dev/null 2>&1
  wait_for_port_free "$TEST_PORT"
  assert_port_free "port free after final stop"
  [ ! -f "$pid_file" ] || { echo "  ASSERT FAIL: PID file not removed after stop"; return 1; }
}

test_normal_start_stop() {
  local pid_file log_file output exit_code
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  rm -f "$pid_file"
  trap 'rm -f "$pid_file" "$log_file"; lsof -iTCP:'"$TEST_PORT"' -sTCP:LISTEN -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null || true' RETURN

  output="$(dashctl_env "$pid_file" "$log_file" start 2>&1)"
  exit_code=$?
  assert_exit "start exit code" 0 "$exit_code"
  [ -f "$pid_file" ] || { echo "  ASSERT FAIL: PID file not created after start"; return 1; }
  assert_port_in_use "port in use after start"

  output="$(dashctl_env "$pid_file" "$log_file" stop 2>&1)"
  exit_code=$?
  assert_exit "stop exit code" 0 "$exit_code"
  wait_for_port_free "$TEST_PORT"
  assert_port_free "port free after stop"
  [ ! -f "$pid_file" ] || { echo "  ASSERT FAIL: PID file not removed after stop"; return 1; }
}

test_start_blocked_shows_pid() {
  local pid_file log_file orphan_pid output exit_code
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  rm -f "$pid_file"
  trap 'rm -f "$pid_file" "$log_file"; lsof -iTCP:'"$TEST_PORT"' -sTCP:LISTEN -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null || true' RETURN

  orphan_pid="$(start_orphan "$log_file")"
  wait_for_port "$TEST_PORT"

  output="$(dashctl_env "$pid_file" "$log_file" start 2>&1)" || true
  exit_code=$?

  assert_exit "start exit code" 1 "$exit_code"
  assert_contains "shows PID" "$orphan_pid" "$output"
  assert_not_contains "no service-managed message" "service-managed" "$output"
}

test_stale_pid_status_not_running() {
  local pid_file log_file output
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  trap 'rm -f "$pid_file" "$log_file"' RETURN

  # Write current shell PID — alive but not a dashboard process
  echo "$$" > "$pid_file"

  output="$(dashctl_env "$pid_file" "$log_file" status 2>&1)"

  assert_contains "reports stopped" "Stopped" "$output"
  assert_not_contains "not running" "Running" "$output"
  # PID file should be cleaned up
  [ ! -f "$pid_file" ] || [ -z "$(cat "$pid_file" 2>/dev/null)" ] || {
    echo "  ASSERT FAIL: stale PID file not cleaned up"
    return 1
  }
}

test_stale_pid_start_recovers() {
  local pid_file log_file output exit_code
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  trap 'rm -f "$pid_file" "$log_file"; lsof -iTCP:'"$TEST_PORT"' -sTCP:LISTEN -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null || true' RETURN

  # Write current shell PID — alive but not dashboard
  echo "$$" > "$pid_file"

  output="$(dashctl_env "$pid_file" "$log_file" start 2>&1)"
  exit_code=$?

  assert_exit "start exit code" 0 "$exit_code"
  assert_port_in_use "port in use after start"

  # Clean up
  dashctl_env "$pid_file" "$log_file" stop >/dev/null 2>&1
  wait_for_port_free "$TEST_PORT"
}

test_default_bind_is_lan() {
  # E3: with no opt-out env, resolve_bind_host (via help output) resolves to 0.0.0.0.
  local pid_file log_file output
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  trap 'rm -f "$pid_file" "$log_file"' RETURN

  output="$(dashctl_env "$pid_file" "$log_file" help 2>&1)"
  assert_contains "default bind 0.0.0.0" "Bind:     0.0.0.0" "$output"
  assert_contains "no-auth note" "NO AUTH" "$output"
}

test_loopback_optout_bind() {
  # E3: DASHCTL_LOOPBACK_ONLY=1 forces loopback bind.
  local pid_file log_file output
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  trap 'rm -f "$pid_file" "$log_file"' RETURN

  output="$(env DASHCTL_LOOPBACK_ONLY=1 DASHCTL_PORT="$TEST_PORT" \
    DASHCTL_PID_FILE="$pid_file" DASHCTL_LOG_FILE="$log_file" \
    DASHCTL_LAUNCHD_PLIST="/tmp/dashctl-test-nonexistent.plist" \
    bash "$DASHCTL" help 2>&1)"
  assert_contains "loopback bind" "Bind:     127.0.0.1" "$output"
}

test_install_threads_bind_host() {
  # E3: install writes the resolved ARCHITECT_HOST into the service definition.
  # We do NOT run a real `install` (it would load a service under the shared label
  # com.architect.dashboard / write to a fixed systemd path). Instead assert the source
  # threads the resolved BIND_HOST into both service generators.
  local out
  out="$(cat "$DASHCTL")"
  # launchd: plistlib injection of ARCHITECT_HOST = resolved BIND_HOST
  assert_contains "launchd threads ARCHITECT_HOST" "EnvironmentVariables', {})['ARCHITECT_HOST'] = '\${BIND_HOST}'" "$out"
  # systemd: Environment=ARCHITECT_HOST=<resolved BIND_HOST>
  assert_contains "systemd threads ARCHITECT_HOST" 'Environment=ARCHITECT_HOST=${BIND_HOST}' "$out"
  # Both install paths resolve the bind host explicitly.
  assert_contains "install resolves bind host" 'BIND_HOST="$(resolve_bind_host)"' "$out"
}

test_stale_pid_restart_recovers() {
  local pid_file log_file output exit_code real_pid
  pid_file="$(mktemp /tmp/dashctl-test-XXXXXX.pid)"
  log_file="$(mktemp /tmp/dashctl-test-XXXXXX.log)"
  rm -f "$pid_file"
  trap 'rm -f "$pid_file" "$log_file"; lsof -iTCP:'"$TEST_PORT"' -sTCP:LISTEN -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null || true' RETURN

  # Start normally
  dashctl_env "$pid_file" "$log_file" start >/dev/null 2>&1
  wait_for_port "$TEST_PORT"
  real_pid="$(cat "$pid_file")"

  # Simulate crash: kill the process, leave stale PID file
  kill "$real_pid" 2>/dev/null || true
  wait_for_port_free "$TEST_PORT"
  # PID file still exists with the now-dead PID
  echo "$real_pid" > "$pid_file"

  # Restart should recover
  output="$(dashctl_env "$pid_file" "$log_file" restart 2>&1)"
  exit_code=$?

  assert_exit "restart exit code" 0 "$exit_code"
  wait_for_port "$TEST_PORT"
  assert_port_in_use "port in use after restart"

  # Clean up
  dashctl_env "$pid_file" "$log_file" stop >/dev/null 2>&1
  wait_for_port_free "$TEST_PORT"
}

# --- Main ---

echo ""
echo "dashctl.sh tests (port $TEST_PORT, isolated)"
echo "============================================="

run_test "orphan: stop kills unmanaged process" test_orphan_stop
run_test "orphan: stop then start recovers" test_orphan_stop_then_start
run_test "normal: start then stop lifecycle" test_normal_start_stop
run_test "blocked start: shows occupying PID" test_start_blocked_shows_pid
run_test "stale PID: status reports stopped" test_stale_pid_status_not_running
run_test "stale PID: start recovers" test_stale_pid_start_recovers
run_test "stale PID: restart recovers" test_stale_pid_restart_recovers
run_test "bind: default resolves to LAN 0.0.0.0" test_default_bind_is_lan
run_test "bind: loopback opt-out resolves to 127.0.0.1" test_loopback_optout_bind
run_test "install: threads ARCHITECT_HOST into service" test_install_threads_bind_host

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""

[ "$FAIL" -eq 0 ]
