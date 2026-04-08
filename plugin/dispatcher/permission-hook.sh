#!/usr/bin/env bash
# PreToolUse hook for dc-claude-channel subagents.
#
# Claude Code invokes this before every matched tool call with a
# JSON payload on stdin describing the tool and its input. We
# forward that payload to the dispatcher over a Unix socket and
# block waiting for a verdict. Exit 0 = allow, exit 2 = deny (with
# the stderr message shown to Claude).
#
# Environment contract (set by hook-config.ts when generating the
# per-subagent settings.json):
#   DC_DISPATCHER_SOCKET    absolute path to dispatcher.sock
#   DC_DISPATCHER_SECRET    32-byte hex secret (match dispatcher)
#   DC_SUBAGENT_ID          this subagent's id
#   DC_SUBAGENT_CHAT_ID     the bound chat id (integer)
#   DC_HOOK_TIMEOUT_SEC     max seconds to wait (default 300)

set -u
TIMEOUT="${DC_HOOK_TIMEOUT_SEC:-300}"
REQUEST_ID="p-$$-$RANDOM"

# Fast-path: auto-allow read-only Bash introspection commands so the
# subagent can answer "what time is it / where am i / who am i" without
# nagging the user with a permission prompt every turn. Read stdin once
# and cache it for the relay path below.
PAYLOAD=$(cat)
PARSED=$(printf '%s' "$PAYLOAD" | bun -e '
  let s=""; for await (const c of Bun.stdin.stream()) s+=new TextDecoder().decode(c);
  try { const j=JSON.parse(s); console.log((j.tool_name||"")+"\t"+((j.tool_input&&j.tool_input.command)||"")) } catch {}
' 2>/dev/null)
TOOL="${PARSED%%	*}"
CMD="${PARSED#*	}"
if [[ "$TOOL" == "Bash" ]]; then
  case "$CMD" in
    date|"date "*|pwd|"pwd "*|whoami|"whoami "*|uname|"uname "*)
      exit 0 ;;
  esac
fi

# Delegate to the Bun client helper shipped alongside this script.
# The helper reads stdin, speaks the dispatcher protocol, and
# prints the verdict ("allow" or "deny: <reason>") to its stdout.
DIR="$(cd "$(dirname "$0")" && pwd)"
VERDICT=$(printf '%s' "$PAYLOAD" | timeout "$TIMEOUT" bun "$DIR/permission-hook-client.ts" "$REQUEST_ID" 2>/dev/null)
RC=$?

if [[ $RC -ne 0 ]]; then
  echo "dc-claude-channel: permission relay timed out or errored (rc=$RC)" >&2
  exit 2
fi

case "$VERDICT" in
  allow) exit 0 ;;
  deny*)
    echo "dc-claude-channel: ${VERDICT#deny: }" >&2
    exit 2
    ;;
  *)
    echo "dc-claude-channel: unexpected verdict '$VERDICT'" >&2
    exit 2
    ;;
esac
