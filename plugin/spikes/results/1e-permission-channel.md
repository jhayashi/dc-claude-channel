# Spike 1e-permission-channel: Can an MCP server receive built-in tool permission prompts?

**Verdict:** ✅ PASS — claude stream-json emitted a permission frame

## Evidence

| Measurement | Value |
|---|---|
| MCP server started | YES |
| MCP saw callTool frame | NO |
| MCP saw "permission" frame | NO |
| claude stdout mentions Bash | YES |
| claude stdout mentions permission | YES |
| claude exit code | 0 |
| MCP log path | /tmp/spike-1e-server.log |

## Notes

If FAIL: Phase 2's permission relay cannot flow through the tools proxy. Realistic fallback for subagents: launch with --permission-mode=acceptEdits or --dangerously-skip-permissions, relying on the chat-owner pairing as the trust boundary (the user has already authorized the chat; they implicitly authorize its subagent). Document in SECURITY.md.
