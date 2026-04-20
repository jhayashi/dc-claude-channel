#!/usr/bin/env bash
# SessionStart hook for the deltachat channel plugin.
#
# Responsibilities (detect-only — no state mutation):
# 1. Channel-flag detection: if Claude Code was launched without
#    --dangerously-load-development-channels, inbound DC messages
#    won't reach this session. Warn the user to relaunch.
# 2. Install-pending banner: if deps are missing or stale, surface a
#    "plugin is installing in the background" banner with phone-side
#    setup instructions. server.ts does the actual `bun install` in
#    a background fork so the user's phone-side setup overlaps.
# 3. Unpaired-session banner: until at least one chat is paired, show
#    the phone-side prerequisites + /deltachat:setup prompt on every
#    launch.
#
# Exits 0 on any transient error to avoid blocking session start. The
# hook never runs `bun install` itself; that's server.ts's job.

set +e

STATE_DIR="${HOME}/.claude/channels/deltachat"
APPROVED_DIR="${STATE_DIR}/approved"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOCK="${PLUGIN_ROOT}/bun.lock"
PKG="${PLUGIN_ROOT}/package.json"

# --- Detect the --dangerously-load-development-channels flag by walking
# up the ancestor process tree (the hook may be launched via a shell or
# node intermediate, so $PPID alone isn't the claude process). If we
# can't inspect any cmdline (unusual platform, restricted /proc), assume
# the flag is present rather than false-positive.
flag_found=0
any_cmd_seen=0
levels_walked=0
last_cmd=""
pid=$PPID
i=0
while [ -n "$pid" ] && [ "$pid" != "0" ] && [ "$pid" != "1" ] && [ "$i" -lt 8 ]; do
  cmd=""
  if [ -r "/proc/$pid/cmdline" ]; then
    cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
  elif command -v ps >/dev/null 2>&1; then
    cmd=$(ps -ww -o command= -p "$pid" 2>/dev/null)
  fi
  if [ -n "$cmd" ]; then
    any_cmd_seen=1
    last_cmd=$(echo "$cmd" | cut -c1-80)
    if echo "$cmd" | grep -q 'dangerously-load-development-channels'; then
      flag_found=1
      break
    fi
  fi
  next_pid=""
  if [ -r "/proc/$pid/status" ]; then
    next_pid=$(grep -E '^PPid:' "/proc/$pid/status" 2>/dev/null | awk '{print $2}')
  elif command -v ps >/dev/null 2>&1; then
    next_pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  fi
  [ -z "$next_pid" ] || [ "$next_pid" = "$pid" ] && break
  pid=$next_pid
  i=$((i + 1))
  levels_walked=$i
done
# If we successfully read at least one ancestor and none had the flag,
# declare it missing. If every read failed, assume the flag is present.
channel_flag_present=1
if [ "$any_cmd_seen" = "1" ] && [ "$flag_found" = "0" ]; then
  channel_flag_present=0
fi

# --- State machine. Priority: flag missing > install pending > paired (silent) > unpaired.

if [ "$channel_flag_present" = "0" ]; then
  diag_cmd=$(printf '%s' "$last_cmd" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r')
  cat <<JSON
{"systemMessage":"Delta Chat plugin is loaded, but the channel flag is MISSING — inbound Delta Chat messages will NOT reach this session.\n\nQuit Claude Code and relaunch with:\n\n    claude --dangerously-load-development-channels plugin:deltachat@dc-claude-channel\n\n(diag: walked ${levels_walked} ancestors, no flag found; last cmdline: ${diag_cmd})"}
JSON
  exit 0
fi

# Install pending: bun.lock missing or older than package.json.
# server.ts detects the same condition and forks `bun install` in the
# background. Every DC tool handler awaits a readiness gate, so tool
# calls issued during install will transparently block for ~30–120s
# rather than crashing on missing native modules.
lock_ok=0
if [ -f "$LOCK" ] && [ -f "$PKG" ] && [ "$LOCK" -nt "$PKG" ]; then
  lock_ok=1
fi

if [ "$lock_ok" = "0" ]; then
  cat <<'JSON'
{"systemMessage":"Delta Chat plugin is installing its native dependencies in the background (~30–120s).\n\nWhile you wait:\n  1. Install Delta Chat on your phone — https://delta.chat/en/download\n  2. Create a free chatmail account from inside the app (one tap, no signup).\n\nWhen the install finishes, run /deltachat:setup to pair your phone.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat plugin is still installing native dependencies in the background. If the user asks to pair or interact with Delta Chat, tell them to wait ~30–120s for the install to finish, then run /deltachat:setup. Tool calls issued during install will transparently block until deps are ready."}}
JSON
  exit 0
fi

paired=0
if [ -d "$APPROVED_DIR" ]; then
  paired=$(find "$APPROVED_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d '[:space:]')
fi

if [ "${paired:-0}" -gt 0 ] 2>/dev/null; then
  exit 0
fi

cat <<'JSON'
{"systemMessage":"Delta Chat plugin is ready.\n\nOn your phone:\n  1. Install Delta Chat — https://delta.chat/en/download\n  2. Create a free chatmail account from inside Delta Chat (one tap, no signup).\n  3. Have the app ready to scan a QR code.\n\nWhen ready, run /deltachat:setup here to pair your phone.\n\nNot for you? Run /plugin uninstall deltachat@dc-claude-channel to remove.","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat plugin is installed but no chat is paired. If the user asks about Delta Chat, pairing, the bot, or QR codes, suggest /deltachat:setup."}}
JSON
exit 0
