#!/usr/bin/env bash
# Smoke test: does `claude -p` cascade SIGTERM to its grandchildren?
#
# Empirical answer (recorded 2026-05-05 against claude 2.1.128): NO.
# claude itself dies on SIGTERM, but its Bash-tool shells and their
# subprocesses orphan and keep running. Reparented to init.
#
# This is the regression check for the process-group kill behavior in
# plugin/dispatcher/subagent-process.ts. Once `detached: true` +
# negative-PID kill ship (GH issue #21), this same script becomes the
# smoke fixture for verifying the cascade actually works.
#
# Run before each release that touches subagent-process.ts:
#   bash scripts/smoke-process-group-kill.sh
#
# Pre-fix expected verdict: "Grandchildren leak. detached:true justified."
# Post-fix expected verdict: "claude -p DOES cascade SIGTERM" (after the
# dispatcher's spawn opts include detached:true and the kill path uses
# negative-PID — only true through the dispatcher, not raw `claude -p`).

set -u

descendants() {
  local pid=$1
  local kids
  kids=$(pgrep -P "$pid" 2>/dev/null || true)
  for k in $kids; do
    echo "$k"
    descendants "$k"
  done
}

cleanup() {
  rm -rf "${ISOLATED_HOME:-}"
  rm -f "${OUT_LOG:-}"
}
trap cleanup EXIT

# Use an isolated HOME so the nested claude doesn't try to load
# dc-claude-channel (or any other plugin) and start its own dispatcher.
# Symlink only auth files; deliberately omit ~/.claude/plugins.
ISOLATED_HOME=$(mktemp -d)
mkdir -p "$ISOLATED_HOME/.claude"
ln -s "$HOME/.claude/.credentials.json" "$ISOLATED_HOME/.claude/.credentials.json" 2>/dev/null || true
ln -s "$HOME/.claude/config.json" "$ISOLATED_HOME/.claude/config.json" 2>/dev/null || true

OUT_LOG=$(mktemp)
# python3 instead of bare `sleep` because claude's Bash sandbox blocks
# bare-sleep heuristics (it wants run_in_background or Monitor patterns).
# python3 + time.sleep is a clean foreground-blocking process the
# sandbox accepts.
PROMPT="Use the Bash tool to run exactly this command (it will block for 90s, expected): python3 -c 'import time; time.sleep(90)'"

echo "=== Spawning isolated claude -p (HOME=$ISOLATED_HOME)"
HOME="$ISOLATED_HOME" claude -p --dangerously-skip-permissions "$PROMPT" > "$OUT_LOG" 2>&1 &
CLAUDE_PID=$!
echo "Claude PID: $CLAUDE_PID"

# Find the python3 grandchild via the descendant tree (avoids matching
# argv strings, which could collide with claude's own command line).
TARGET_PID=""
for i in $(seq 1 60); do
  sleep 1
  for d in $(descendants "$CLAUDE_PID"); do
    [ -r "/proc/$d/comm" ] || continue
    comm=$(cat "/proc/$d/comm" 2>/dev/null || echo "")
    if [ "$comm" = "python3" ]; then
      TARGET_PID="$d"
      break 2
    fi
  done
done

if [ -z "$TARGET_PID" ]; then
  echo "FAIL: no python3 grandchild within 60s — claude likely failed to run the prompt"
  echo "--- claude tree ---"
  pstree -p "$CLAUDE_PID" 2>&1 || true
  echo "--- claude output ---"
  cat "$OUT_LOG"
  kill -TERM "$CLAUDE_PID" 2>/dev/null
  exit 1
fi

echo "Found python3 grandchild PID: $TARGET_PID"
echo "--- process tree before SIGTERM ---"
pstree -p "$CLAUDE_PID" 2>&1 || ps --ppid "$CLAUDE_PID" -o pid,ppid,cmd

echo "=== Sending SIGTERM to claude ($CLAUDE_PID)"
kill -TERM "$CLAUDE_PID"
sleep 4

CLAUDE_ALIVE=0
TARGET_ALIVE=0
kill -0 "$CLAUDE_PID" 2>/dev/null && CLAUDE_ALIVE=1
kill -0 "$TARGET_PID" 2>/dev/null && TARGET_ALIVE=1

echo "  Claude $CLAUDE_PID:  $([ $CLAUDE_ALIVE = 1 ] && echo STILL\ ALIVE || echo died)"
echo "  python3 $TARGET_PID: $([ $TARGET_ALIVE = 1 ] && echo STILL\ ALIVE || echo died)"
echo ""

if [ $CLAUDE_ALIVE = 0 ] && [ $TARGET_ALIVE = 0 ]; then
  echo "VERDICT: claude -p DOES cascade SIGTERM (or process group is in effect)."
  exit 0
elif [ $CLAUDE_ALIVE = 0 ] && [ $TARGET_ALIVE = 1 ]; then
  echo "VERDICT: claude -p does NOT cascade. Grandchildren leak."
  echo "(cleaning up orphan)"
  kill -KILL "$TARGET_PID" 2>/dev/null
  exit 2  # nonzero so CI catches a regression after the fix lands
else
  echo "INCONCLUSIVE — claude survived its own SIGTERM (claude_alive=$CLAUDE_ALIVE target_alive=$TARGET_ALIVE)"
  kill -KILL "$CLAUDE_PID" 2>/dev/null
  kill -KILL "$TARGET_PID" 2>/dev/null
  exit 3
fi
