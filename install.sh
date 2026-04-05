#!/usr/bin/env bash
set -euo pipefail

# Delta Chat Channel for Claude Code — Installer
# Installs dependencies and registers the plugin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$SCRIPT_DIR/plugin"
PLUGINS_FILE="$HOME/.claude/plugins/installed_plugins.json"

echo "Delta Chat Channel for Claude Code"
echo "==================================="
echo

# --- Check prerequisites ---

missing=()
command -v bun >/dev/null 2>&1 || missing+=("bun (https://bun.sh/)")
command -v claude >/dev/null 2>&1 || missing+=("claude (Claude Code CLI)")
command -v deltachat-rpc-server >/dev/null 2>&1 || missing+=("deltachat-rpc-server (pipx install deltachat-rpc-server)")
command -v zip >/dev/null 2>&1 || missing+=("zip (sudo apt install zip)")

if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing prerequisites:"
  for m in "${missing[@]}"; do
    echo "  - $m"
  done
  echo
  echo "Install them and re-run this script."
  exit 1
fi

echo "Prerequisites: OK"

# --- Install dependencies ---

echo "Installing dependencies..."
cd "$PLUGIN_DIR"
bun install --no-summary
echo "Dependencies: OK"

# --- Build WebXDC apps ---

echo "Building WebXDC apps..."
cd "$PLUGIN_DIR"
bun run scripts/build-viewer-html.ts
echo "WebXDC apps: OK"

# --- Register plugin ---

echo "Registering plugin..."

mkdir -p "$(dirname "$PLUGINS_FILE")"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
ENTRY=$(cat <<EOF
{
  "scope": "user",
  "installPath": "$PLUGIN_DIR",
  "version": "0.1.0",
  "installedAt": "$TIMESTAMP",
  "lastUpdated": "$TIMESTAMP"
}
EOF
)

if [ -f "$PLUGINS_FILE" ]; then
  # Check if deltachat@inline is already registered
  if grep -q '"deltachat@inline"' "$PLUGINS_FILE" 2>/dev/null; then
    # Update the installPath in case the repo moved
    UPDATED=$(bun -e "
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync('$PLUGINS_FILE', 'utf-8'));
      const entry = data.plugins['deltachat@inline'];
      if (entry && entry[0]) {
        entry[0].installPath = '$PLUGIN_DIR';
        entry[0].lastUpdated = '$TIMESTAMP';
      }
      console.log(JSON.stringify(data, null, 2));
    ")
    echo "$UPDATED" > "$PLUGINS_FILE"
    echo "Plugin already registered — updated installPath."
  else
    # Add deltachat@inline to existing plugins
    UPDATED=$(bun -e "
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync('$PLUGINS_FILE', 'utf-8'));
      if (!data.plugins) data.plugins = {};
      data.plugins['deltachat@inline'] = [$ENTRY];
      console.log(JSON.stringify(data, null, 2));
    ")
    echo "$UPDATED" > "$PLUGINS_FILE"
    echo "Plugin registered."
  fi
else
  # Create new file
  cat > "$PLUGINS_FILE" <<JSONEOF
{
  "version": 2,
  "plugins": {
    "deltachat@inline": [$ENTRY]
  }
}
JSONEOF
  echo "Plugin registered (created $PLUGINS_FILE)."
fi

# --- Done ---

echo
echo "Installation complete!"
echo
echo "To start Claude Code with the Delta Chat channel:"
echo
echo "  claude --plugin-dir $PLUGIN_DIR \\"
echo "    --dangerously-load-development-channels plugin:deltachat@inline"
echo
echo "On first run, the bot auto-provisions a chatmail account."
echo "Run /deltachat:configure invite to get the QR code for your phone."
