# Spike 1b-mcp-over-unix: MCP server tunneled over a Unix socket (wire-protocol level)

**Verdict:** ✅ PASS — wire protocol round-trip + auth + unknown-tool error all work

## Evidence

| Measurement | Value |
|---|---|
| hello → helloAck | PASS |
| echo round-trip | PASS |
| unknown tool → toolError | PASS |
| bad secret → auth error | PASS |

## Notes

This spike covers the framing/protocol layer only. Spike 1E covers loading the proxy as an MCP server inside `claude -p`.
