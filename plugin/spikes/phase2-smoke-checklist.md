# Phase 2 Manual Smoke Test

Run after Phase 2 is committed. Assumes the dev plugin-dir install
path is already set up and a paired chat exists.

## Setup

1. `cd plugin && bun install && bun test` — all green
2. Restart Claude Code with the plugin loaded via `--plugin-dir`
3. Confirm `/mcp` lists `plugin:deltachat:deltachat` connected
4. Check `~/.claude/channels/deltachat/debug.log` for
   `dispatcher socket listening` at startup

## Test 1 — first message cold spawn

1. Send "hi" from Delta Chat to the paired chat
2. Watch `debug.log` for `router: dispatching chat=N len=2` and
   `cache: evicting` NOT present (first spawn)
3. Confirm Claude responds within ~6 seconds (cold spawn + reply)
4. Confirm the subagent process is visible: `pgrep -af claude`

## Test 2 — warm second message

1. Send "what did I just say?" to the same chat
2. Confirm the response references "hi" (in-process context continuity)
3. Confirm response latency < 2 seconds (warm subagent)
4. Check the subagent pid from Test 1 is still alive

## Test 3 — per-chat isolation

1. Pair a second chat (or use an existing one)
2. Send messages to both chats in quick succession
3. Confirm `debug.log` shows two different subagent ids handling
   the two chats in parallel
4. Confirm `pgrep -c -f "claude -p"` shows 2 subagents

## Test 4 — permission prompt via hook

1. In one of the paired chats, ask Claude to run a Bash command
   (e.g. "what's the current date?")
2. Confirm a WebXDC permission prompt appears in the chat
3. Tap Allow
4. Confirm Claude proceeds and replies with the date
5. Tap Deny in a separate test and confirm Claude acknowledges the
   block

## Test 5 — LRU eviction

1. Temporarily set `DC_SUBAGENT_MAX_ACTIVE=2` in `.env`
2. Restart the plugin
3. Pair and send messages to 3 different chats in sequence
4. Confirm `debug.log` logs `cache: evicting LRU chat=X` for the
   first chat when the 3rd message arrives
5. Confirm `pgrep -c -f "claude -p"` never exceeds 2

## Test 6 — idle timeout

1. Set `DC_SUBAGENT_IDLE_TIMEOUT_MIN=1`
2. Send a message, wait 90 seconds
3. Confirm `debug.log` logs `cache: idle timeout chat=N`
4. Confirm `pgrep -c -f "claude -p"` is 0

## Test 7 — temp dir cleanup

1. Before sending: `ls /tmp/dc-subagent-* 2>/dev/null | wc -l` (baseline)
2. Send a message; subagent spawns; new tempdir is created
3. Wait for idle timeout; subagent exits
4. Re-count `/tmp/dc-subagent-*` — should be back to baseline (no leak)

## Pass criteria

All 7 tests green and no stuck subagents after shutting down Claude
Code. Close any remaining subagents with
`pkill -f "claude -p --session-id dc-chat-"` if observed — they are
orphans and Phase 3 will address recovery.
