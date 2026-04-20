#!/usr/bin/env bash
# Remove the dc-claude-channel plugin from this machine.
#
# Usage: ./uninstall.sh [--purge-state]
#
# Default: removes plugin install + marketplace + JSON references.
#          Leaves ~/.claude/channels/deltachat/ (pairings, agents, bindings).
# --purge-state: also wipes the channel state dir (unrecoverable).

set -euo pipefail

PURGE_STATE=0
for arg in "$@"; do
  case "$arg" in
    --purge-state) PURGE_STATE=1 ;;
    -h|--help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
PLUGINS_DIR="$CLAUDE_DIR/plugins"
MARKETPLACE="dc-claude-channel"

command -v jq >/dev/null 2>&1 || { echo "error: jq is required" >&2; exit 1; }

# Atomic JSON rewrite: jq filter $1, file $2.
jq_rewrite() {
  local filter="$1" file="$2"
  [[ -f "$file" ]] || return 0
  local tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  if jq "$filter" "$file" >"$tmp"; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    echo "warning: jq rewrite failed on $file (left unchanged)" >&2
  fi
}

echo "removing plugin cache + marketplace clone"
rm -rf "$PLUGINS_DIR/cache/$MARKETPLACE"
rm -rf "$PLUGINS_DIR/marketplaces/$MARKETPLACE"

echo "scrubbing installed_plugins.json"
jq_rewrite \
  '.plugins |= with_entries(select(.key | endswith("@'"$MARKETPLACE"'") | not))' \
  "$PLUGINS_DIR/installed_plugins.json"

echo "scrubbing known_marketplaces.json"
jq_rewrite "del(.\"$MARKETPLACE\")" "$PLUGINS_DIR/known_marketplaces.json"

echo "scrubbing enabledPlugins in settings files"
for settings in "$CLAUDE_DIR/settings.json" "$CLAUDE_DIR/settings.local.json"; do
  [[ -f "$settings" ]] || continue
  jq_rewrite \
    'if .enabledPlugins then .enabledPlugins |= with_entries(select(.key | endswith("@'"$MARKETPLACE"'") | not)) else . end' \
    "$settings"
done

if [[ "$PURGE_STATE" == "1" ]]; then
  echo "purging channel state dir (~/.claude/channels/deltachat)"
  rm -rf "$CLAUDE_DIR/channels/deltachat"
else
  if [[ -d "$CLAUDE_DIR/channels/deltachat" ]]; then
    echo "note: channel state (pairings, agents, bindings) kept at:"
    echo "      $CLAUDE_DIR/channels/deltachat"
    echo "      re-run with --purge-state to wipe it too."
  fi
fi

echo "done."
