#!/usr/bin/env bash
# Spike 1G PreToolUse hook. Logs invocation to /tmp/spike-1g-hook.log
# (with the JSON payload Claude sent on stdin), sleeps 2 seconds to
# simulate a synchronous round-trip to the dispatcher (where in the
# real system we'd be waiting for a Delta Chat WebXDC verdict), and
# exits 0 to allow the tool call to proceed.
set -e
LOG=/tmp/spike-1g-hook.log
STDIN_CONTENT=$(cat)
{
  echo "---"
  date -Iseconds
  echo "pid=$$"
  echo "stdin: $STDIN_CONTENT"
} >> "$LOG"
sleep 2
exit 0
