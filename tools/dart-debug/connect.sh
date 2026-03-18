#!/usr/bin/env bash
# Auto-detect Dart VM Service URI from a running flutter process.
# Usage: source connect.sh
#   Sets $DART_VM_URI for use with other tools.

# Try flutter daemon log files first
FLUTTER_LOG=$(ls -t /tmp/flutter_tools.* 2>/dev/null | head -1)
if [ -n "$FLUTTER_LOG" ]; then
  URI=$(grep -oE 'ws://127\.0\.0\.1:[0-9]+/[A-Za-z0-9_-]+=/ws' "$FLUTTER_LOG" | tail -1)
  if [ -n "$URI" ]; then
    export DART_VM_URI="$URI"
    echo "Found VM Service URI from flutter log: $DART_VM_URI"
    return 0 2>/dev/null || exit 0
  fi
fi

# Try finding from running flutter process output
URI=$(ps aux | grep -oE 'ws://127\.0\.0\.1:[0-9]+/[A-Za-z0-9_-]+=/ws' | head -1)
if [ -n "$URI" ]; then
  export DART_VM_URI="$URI"
  echo "Found VM Service URI from process list: $DART_VM_URI"
  return 0 2>/dev/null || exit 0
fi

# Try common observatory ports
for PORT in $(seq 8100 8120); do
  if curl -s --max-time 1 "http://127.0.0.1:$PORT" > /dev/null 2>&1; then
    echo "Found Dart VM Service on port $PORT — but need full URI with token."
    echo "Check flutter run output for: 'Connecting to VM Service at ws://...'"
    return 1 2>/dev/null || exit 1
  fi
done

echo "No running Dart VM Service found."
echo "Start your app with: flutter run --debug"
echo "Then look for: 'Connecting to VM Service at ws://127.0.0.1:<port>/<token>/ws'"
return 1 2>/dev/null || exit 1
