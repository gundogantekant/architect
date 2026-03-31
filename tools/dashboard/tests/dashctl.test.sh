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

# --- Main ---

echo ""
echo "dashctl.sh tests (port $TEST_PORT, isolated)"
echo "============================================="

run_test "orphan: stop kills unmanaged process" test_orphan_stop
run_test "orphan: stop then start recovers" test_orphan_stop_then_start
run_test "normal: start then stop lifecycle" test_normal_start_stop
run_test "blocked start: shows occupying PID" test_start_blocked_shows_pid

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo ""

[ "$FAIL" -eq 0 ]
