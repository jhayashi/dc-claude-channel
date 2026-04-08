# Spike 1g-pretooluse-hook: PreToolUse hooks fire in `claude -p` and can gate tool calls

**Verdict:** ✅ PASS — hook fired, blocked synchronously for 2s, allowed Bash to run; Phase 2 permission relay via hook+socket is viable

## Evidence

| Measurement | Value |
|---|---|
| hook log exists | YES |
| hook invocations | 1 |
| hook saw Bash tool_name | YES |
| bash output "cobalt" in stdout | YES |
| total wall time | 21519 ms (budget ≥ 2000) |
| permission_denials length | 0 |
| claude exit code | 0 |
| hook log (truncated) | --- | 2026-04-07T22:15:47-07:00 | pid=539750 | stdin: {"session_id":"f6749f1a-ec45-45d8-88bc-48c9cb5576cf","transcript_path":"/var/home/jhayashi/.claude/projects/-var-home-jhayashi-src-dc-claude-channel/f67 |

## Notes

If PASS: Phase 2's permission relay is a PreToolUse hook shell script that (a) reads the tool_input from stdin, (b) opens the dispatcher's Unix socket, (c) sends a permission_request frame, (d) blocks reading the reply, (e) exits 0 for allow or 2 for deny. The dispatcher forwards to the existing permissions-app WebXDC flow, waits for the user's verdict, and writes the reply. This preserves the existing dc-channel UX exactly (tap Allow/Deny in DC) while working in headless -p mode. No SDK hacks, no stream-json input frames, no architectural compromise.
