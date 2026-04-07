# v0.8.2 plan — first-launch pairing prompt

## Goal

After `/plugin install deltachat@dc-claude-channel`, the user's *next*
Claude Code session surfaces a clear pointer to `/deltachat:configure
invite` without them having to read the README. Once they pair at least
one chat, the prompt goes silent. If they later un-pair to zero, it
re-triggers.

## Approach

A SessionStart hook bundled in the plugin, declared in `plugin.json` per
the official plugin hooks schema (verified with claude-code-guide):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh" }
        ]
      }
    ]
  }
}
```

Hook runs async, doesn't block session start, exits 0 on any error.

## State signals

- **Paired count:** number of regular files in `~/.claude/channels/deltachat/approved/`. Zero = unpaired.
- **Welcomed flag:** `${CLAUDE_PLUGIN_DATA}/.welcomed` — written the first time the inline welcome fires. Used to gate one-shot inline message vs. silent context.

## Behavior matrix

| State | What the hook does |
|---|---|
| `approved/` empty AND `.welcomed` missing | Emit **inline welcome** (JSON `additionalContext` with first-session message); write `.welcomed` flag |
| `approved/` empty AND `.welcomed` present | Emit **silent system context** (one short line) |
| `approved/` has ≥1 entry | Exit 0 silently. If `.welcomed` exists, leave it (so it re-fires on un-pair) |
| State dir doesn't exist | Treat as "empty" → emit inline welcome and create dir |

## Hook script

`plugin/scripts/session-start.sh` — plain bash, no Bun dependency, no DC connection.

```bash
#!/usr/bin/env bash
set -e
STATE_DIR="${HOME}/.claude/channels/deltachat"
APPROVED_DIR="${STATE_DIR}/approved"
WELCOMED_FLAG="${CLAUDE_PLUGIN_DATA}/.welcomed"

# Count paired chats (zero if dir missing)
paired=0
if [ -d "$APPROVED_DIR" ]; then
  paired=$(find "$APPROVED_DIR" -maxdepth 1 -type f | wc -l)
fi

if [ "$paired" -gt 0 ]; then
  exit 0
fi

mkdir -p "$(dirname "$WELCOMED_FLAG")" 2>/dev/null || true

if [ ! -f "$WELCOMED_FLAG" ]; then
  # First-ever inline welcome
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat channel plugin is installed but no chat is paired yet. To set up the bot and get a QR code for your phone, suggest the user run: /deltachat:configure invite\n\nGreet the user briefly and tell them you noticed Delta Chat is installed but unpaired, then offer the command above as the next step."}}
EOF
  touch "$WELCOMED_FLAG" 2>/dev/null || true
  exit 0
fi

# Subsequent sessions while still unpaired — silent hint
cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"The Delta Chat plugin is installed but no chat is paired. If the user asks about Delta Chat, pairing, the bot, or QR codes, suggest /deltachat:configure invite."}}
EOF
exit 0
```

## Files touched

- **New:** `plugin/scripts/session-start.sh` (chmod +x)
- **Modified:** `plugin/.claude-plugin/plugin.json` — add `hooks` block, bump version 0.8.1 → 0.8.2
- **Modified:** `.claude-plugin/marketplace.json` — bump version 0.8.1 → 0.8.2
- **Modified:** `CLAUDE.md` — document the hook behavior

## Tests

The hook is shell, not TypeScript — but the logic is testable. Add
`test/session-start-hook.test.ts` that shells out to the script with a
temp `STATE_DIR` and `CLAUDE_PLUGIN_DATA` and asserts:

1. Empty state, no welcomed flag → emits inline JSON, creates flag
2. Empty state, welcomed flag exists → emits silent JSON, flag still exists
3. Paired chat present → exits 0 with no output
4. State dir missing → behaves as empty
5. CLAUDE_PLUGIN_DATA missing → graceful degrade (still emits, just can't write flag)

## Risk + open items

| Risk | Mitigation |
|---|---|
| `additionalContext` schema changes between Claude Code versions | Hook exits 0 on any failure; worst case the user sees no welcome and runs `/deltachat:configure invite` from the README |
| `find ... \| wc -l` whitespace issues across platforms | Wrap in `$(...)` and trim; tested on Linux + macOS |
| User paired via a different machine; state dir empty here | Acceptable — they'll see one welcome message per machine, harmless |
| Hook fires on `--continue` / `--resume` sessions too | `matcher: "startup"` only fires for new sessions; verify in testing |
| `CLAUDE_PLUGIN_DATA` not set when hook runs from `claude` (no plugin context) | Skip flag write, still emit context |

## Estimated effort

- Hook script + plugin.json wiring: 30 min
- Tests: 30 min
- Manual verification on a fresh install: 20 min
- Commit + tag v0.8.2 + push: 10 min

**Total: ~1.5 hours.**
