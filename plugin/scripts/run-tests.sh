#!/usr/bin/env bash
# Run the `bun test` suite without risking the caller's session.
#
# Why this exists: on the D4C / Delta Chat development path the suite runs
# under a `claude -p` agent whose process, the live dispatcher, the
# keepalive, and the test runner all share one cgroup
# (user-NNNN.slice/session-N.scope). Two things follow from that coupling:
#
#   1. A memory-pressure event lets systemd-oomd/the kernel SIGKILL the
#      biggest-RSS member of the scope — the fat-context claude process —
#      so the agent dies mid-run (exit 137) and takes the dispatcher with
#      it. The suite's own peak is tiny (~560 MiB, 1407 tests green); the
#      kill is purely an artifact of being foreground-attached.
#   2. Even a benign blocking waiter in the agent's foreground gets
#      SIGTERM'd (143) under that pressure and reports a misleading exit
#      code, although the detached run finished fine.
#
# The detached run ALWAYS completes. So the agent-safe contract is
# fire-and-forget + a cheap separate status poll — never block the agent's
# foreground on the heavy run.
#
# Usage:
#   scripts/run-tests.sh [bun-test-args...]   # launch detached, return now
#   scripts/run-tests.sh --status             # report result (exit = test code,
#                                             #   or 2 if still running)
#   scripts/run-tests.sh --wait [args...]     # block + mirror output + real
#                                             #   exit code (INTERACTIVE TERMINAL
#                                             #   ONLY — not for a D4C agent)
#
# Result log + sentinel: $DC_TEST_LOG (default /tmp/dc-bun-test.log).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 9
LOG="${DC_TEST_LOG:-/tmp/dc-bun-test.log}"

launch() {  # launch the suite in its own session; sentinel marks completion
  : > "$LOG"
  setsid bash -c 'bun test "$@" > "'"$LOG"'" 2>&1; echo "DC_TEST_EXIT=$?" >> "'"$LOG"'"' _ "$@" &
  disown 2>/dev/null || true
}

case "${1:-}" in
  --status)
    if ! [ -s "$LOG" ]; then echo "no run found (log empty): $LOG"; exit 2; fi
    ec="$(sed -n 's/^DC_TEST_EXIT=//p' "$LOG" | tail -1)"
    if [ -z "$ec" ]; then echo "still running — re-check $LOG"; exit 2; fi
    grep -E "[0-9]+ (pass|fail|skip)|Ran [0-9]+ tests" "$LOG" | tail -4
    echo "exit=$ec"
    exit "$ec"
    ;;
  --wait)
    shift
    launch "$@"
    # Terminal-only: poll the sentinel in the foreground and mirror output.
    while ! grep -q '^DC_TEST_EXIT=' "$LOG" 2>/dev/null; do sleep 0.5; done
    cat "$LOG"
    exit "$(sed -n 's/^DC_TEST_EXIT=//p' "$LOG" | tail -1)"
    ;;
  *)
    launch "$@"
    echo "bun test launched detached — results → $LOG"
    echo "check with: scripts/run-tests.sh --status"
    exit 0
    ;;
esac
