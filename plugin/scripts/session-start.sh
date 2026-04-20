#!/usr/bin/env bash
# SessionStart hook for the deltachat channel plugin.
#
# Two responsibilities:
# 1. Install-on-first-launch: when node_modules is missing or stale,
#    run `bun install` synchronously (~2 min) and emit a banner telling
#    the user what to do next (on phone + in terminal).
# 2. Unpaired-session hint: if no chats are paired, inject context so
#    Claude mentions /deltachat:setup if the user brings it up.
#
# Exits 0 on any transient error to avoid blocking session start, except
# when bun install fails — there we exit non-zero so Claude Code
# surfaces the failure.

set +e

STATE_DIR="${HOME}/.claude/channels/deltachat"
APPROVED_DIR="${STATE_DIR}/approved"
WELCOMED_FLAG="${CLAUDE_PLUGIN_DATA:-${STATE_DIR}}/.welcomed"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_MODULES="${PLUGIN_ROOT}/node_modules"
LOCK="${PLUGIN_ROOT}/bun.lock"
PKG="${PLUGIN_ROOT}/package.json"

# Freshness: node_modules/ exists AND bun.lock is newer than
# package.json. A fresh install always rewrites bun.lock, so this
# catches both first-time installs and dep-change situations.
needs_install=1
if [ -d "$NODE_MODULES" ] && [ -f "$LOCK" ] && [ -f "$PKG" ] && [ "$LOCK" -nt "$PKG" ]; then
  needs_install=0
fi

if [ "$needs_install" = "1" ]; then
  if ! cd "$PLUGIN_ROOT" 2>/dev/null; then
    cat <<'JSON'
{"systemMessage":"Delta Chat plugin setup failed: could not access plugin directory. Run `bun install` in the plugin dir manually, then restart Claude Code."}
JSON
    exit 1
  fi

  if ! bun install --no-summary >/dev/null 2>&1; then
    cat <<'JSON'
{"systemMessage":"Delta Chat plugin install failed. Run `bun install` in the plugin directory manually, then restart Claude Code."}
JSON
    exit 1
  fi

  cat <<'JSON'
{"systemMessage":"Delta Chat plugin is ready.\n\nOn your phone:\n  1. Install Delta Chat — https://delta.chat/en/download\n  2. Create a free chatmail account from inside Delta Chat (one tap, no signup).\n  3. Have the app ready to scan a QR code.\n\nWhen ready, run /deltachat:setup here to pair your phone."}
JSON
  exit 0
fi

# Fast path: deps already installed. Emit the unpaired-session hint.
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
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat channel plugin is installed but no chat is paired yet. Greet the user briefly and tell them you noticed Delta Chat is installed but unpaired. Then suggest they run /deltachat:setup to pair their phone."}}
JSON
  touch "$WELCOMED_FLAG" 2>/dev/null
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat plugin is installed but no chat is paired. If the user asks about Delta Chat, pairing, the bot, or QR codes, suggest /deltachat:setup."}}
JSON
exit 0
