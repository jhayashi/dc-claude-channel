# Phase 1 Feasibility Spikes

Throwaway scripts that answer load-bearing questions before the v0.9
subagent rewrite. None of this code ships. See
`docs/plan-issue-1.md` §"Phase 1" for context.

## Running a spike

    bun plugin/spikes/<spike-id>.ts

Each spike writes a markdown report to `results/<spike-id>.md` and
exits 0 (pass) or 1 (fail). All five must pass before Phase 2 starts;
any failure either triggers a documented fallback or cuts a phase.

## Spikes

- `1a-named-sessions.ts` — `claude -p --session` continuity, parallelism, cold/warm latency
- `1b-mcp-over-unix.ts` — MCP server tunneled over a Unix socket
- `1c-allowed-tools.ts` — `claude -p --allowedTools` flag actually blocks omitted tools
- `1d-model-flag.ts` — `claude -p --model` accepts haiku/sonnet/opus
- `1e-permission-channel.ts` — MCP server registers as a permission channel
