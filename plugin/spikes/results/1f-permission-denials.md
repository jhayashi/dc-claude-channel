# Spike 1f-permission-denials: Built-in permission decisions exposed via stream-json

**Verdict:** ✅ PASS — permission_denials is observable in the result frame; dispatcher can relay denials to DC as status messages

## Evidence

| Measurement | Value |
|---|---|
| victim path | /tmp/spike-1f-victim-ed77164951d3.txt |
| result frame present | YES |
| permission_denials length | 1 |
| denied tool | Bash |
| denied command | rm -f /tmp/spike-1f-victim-ed77164951d3.txt && echo removed |
| block enforced (file still exists) | YES |
| claude exit code | 0 |

## Notes

Implication for Phase 2: the dispatcher can watch every subagent's stream-json output for result frames with non-empty permission_denials and forward them to DC as "⚠️ blocked" status messages. This is NOT an interactive prompt — the runtime has already decided — but it gives the user visibility into what Claude tried to do and was denied, which is the observable side of the permission story we need. For finer-grained control, Phase 2 subagents can use --add-dir to extend the CWD sandbox per-chat.
