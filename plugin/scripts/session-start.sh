#!/usr/bin/env bash
# SessionStart hook for the deltachat channel plugin.
#
# Surfaces a one-time welcome message pointing the user at
# /deltachat:configure invite when no chats are paired yet, then a
# silent system context hint on subsequent unpaired sessions.
#
# Exits 0 on any error to avoid blocking session start.

set +e

STATE_DIR="${HOME}/.claude/channels/deltachat"
APPROVED_DIR="${STATE_DIR}/approved"
WELCOMED_FLAG="${CLAUDE_PLUGIN_DATA:-${STATE_DIR}}/.welcomed"

# Count paired chats (zero if dir missing).
paired=0
if [ -d "$APPROVED_DIR" ]; then
  paired=$(find "$APPROVED_DIR" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d '[:space:]')
fi

if [ "${paired:-0}" -gt 0 ] 2>/dev/null; then
  exit 0
fi

mkdir -p "$(dirname "$WELCOMED_FLAG")" 2>/dev/null

if [ ! -f "$WELCOMED_FLAG" ]; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat channel plugin is installed but no chat is paired yet. Greet the user briefly and tell them you noticed Delta Chat is installed but unpaired. Then suggest they run /deltachat:configure invite to get a QR code they can scan with the Delta Chat app on their phone."}}
JSON
  touch "$WELCOMED_FLAG" 2>/dev/null
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat plugin is installed but no chat is paired. If the user asks about Delta Chat, pairing, the bot, or QR codes, suggest /deltachat:configure invite."}}
JSON
exit 0
