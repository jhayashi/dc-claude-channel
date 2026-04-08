# Spike 1e-permission-channel: Can an MCP server receive built-in tool permission prompts?

**Verdict:** ❌ FAIL — no permission operation seen on either channel; MCP servers cannot act as permission channels for built-in tools

## Evidence

| Measurement | Value |
|---|---|
| MCP server started | YES |
| MCP saw tools/call frame | NO |
| MCP saw real permission op | NO |
| claude stdout mentions Bash tool_use | YES |
| claude stdout contained real permission op | NO |
| claude stdout contained a denial | NO |
| claude exit code | 0 |
| MCP log path | /tmp/spike-1e-server.log |

## Notes

If FAIL: Phase 2's permission relay cannot flow through the tools proxy. Realistic fallback for subagents: launch with --permission-mode=acceptEdits or --dangerously-skip-permissions, relying on the chat-owner pairing as the trust boundary (the user has already authorized the chat; they implicitly authorize its subagent). Document in SECURITY.md.
