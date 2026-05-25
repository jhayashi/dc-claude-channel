#!/usr/bin/env bash
# SessionStart hook for the deltachat channel plugin.
#
# Responsibilities (detect-only — no state mutation):
# 1. Channel-flag detection: if Claude Code was launched without
#    --dangerously-load-development-channels, inbound DC messages
#    won't reach this session. Warn the user to relaunch.
# 2. Unpaired-session banner: until at least one chat is paired, show
#    the phone-side prerequisites + /deltachat:setup prompt on every
#    launch.
#
# Install state is intentionally NOT surfaced here — server.ts forks
# `bun install` in the background when deps are missing, and every DC
# tool handler awaits a readiness gate, so tool calls issued during
# install transparently block rather than crashing. Users don't need
# a banner to know about it.
#
# Exits 0 on any transient error to avoid blocking session start. The
# hook never runs `bun install` itself; that's server.ts's job.

set +e

STATE_DIR="${HOME}/.claude/channels/deltachat"
APPROVED_DIR="${STATE_DIR}/approved"

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
#
# DC_CHANNEL_FLAG_PRESENT=1 is an explicit override of the heuristic walk
# above — for launch wrappers (or this hook's own tests) where the flag is
# known to be in effect but an intermediate process hides it from the walk.
channel_flag_present=1
if [ "${DC_CHANNEL_FLAG_PRESENT:-}" = "1" ]; then
  channel_flag_present=1
elif [ "$any_cmd_seen" = "1" ] && [ "$flag_found" = "0" ]; then
  channel_flag_present=0
fi

# --- State machine. Priority: flag missing > paired (silent) > unpaired.

if [ "$channel_flag_present" = "0" ]; then
  diag_cmd=$(printf '%s' "$last_cmd" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n\r')
  cat <<JSON
{"systemMessage":"Delta Chat plugin is loaded, but the channel flag is MISSING — inbound Delta Chat messages will NOT reach this session.\n\nQuit Claude Code and relaunch with:\n\n    claude --dangerously-load-development-channels plugin:deltachat@dc-claude-channel\n\n(diag: walked ${levels_walked} ancestors, no flag found; last cmdline: ${diag_cmd})"}
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
