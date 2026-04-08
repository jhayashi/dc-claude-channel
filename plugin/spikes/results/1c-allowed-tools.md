# Spike 1c-allowed-tools: `claude -p --allowedTools` blocks omitted tools

**Verdict:** ❌ FAIL — BLOCK FAILED — disallowed Read still leaked the file

## Evidence

| Measurement | Value |
|---|---|
| 1. disallowed Read leaked secret | YES (cobalt-1775623934745) |
|    → exit code | 0 |
|    → stdout (truncated) | cobalt-1775623934745 |
| 2. mcp__ prefix flag accepted | YES |
|    → exit code | 1 |
|    → stderr (truncated) | Error: Input must be provided either through stdin or as a prompt argument when using --print |

## Notes

If 1 fails: subagents must enforce tool restrictions at the dispatcher socket boundary instead of trusting --allowedTools. If 2 fails: tools-proxy must use unprefixed tool names.
