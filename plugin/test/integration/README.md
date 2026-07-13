# Tier-2 DC integration harness

Real `@deltachat/stdio-rpc-server` driving two accounts on a local
chatmail relay container. Pairs them through the production
`/deltachat:setup` flow and exercises the dispatcher end-to-end.
Slow; gated; not run by default.

See `docs/specs/2026-04-20-e2e-testing-proposal.md` §Layer 2 for the
full design.

## Prerequisites

Start the local relay **once** before running the suite (leave it running):

```bash
cd plugin/test/integration/chatmail-docker
./podman-run.sh up   # Podman
# or: docker compose up -d   # Docker
```

The relay binds `localhost:8443` (HTTPS `/new`), `localhost:10465`
(SMTPS), and `localhost:10993` (IMAPS). See `chatmail-docker/README.md`
for full lifecycle docs.

## Running

```bash
cd plugin
DC_INTEGRATION_TEST=1 bun run test:integration
```

The suite skips with an actionable hint if `DC_INTEGRATION_TEST` is
unset OR the relay is unreachable — no silent false-green.

## Env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `DC_INTEGRATION_TEST` | — | Must be `1` to enable the suite |
| `DC_TEST_SUBAGENT` | — | Set `1` to opt into the subagent-lifecycle test (incurs ~1 Anthropic turn per run) |
| `DC_TEST_RELAY` | `localhost:8443` | Relay host:port for HTTPS `/new` API |
| `DC_REUSE_ACCOUNTS` | — | Set `1` to reuse `.fixtures/` and `.fixtures-subagent/` across runs |
| `RELAY_IMAPS_PORT` | `10993` | IMAP port of the local relay |
| `RELAY_SMTPS_PORT` | `10465` | SMTP submission port of the local relay |
| `DC_RPC_DEBUG` | — | Set `1` to unmute dispatcher `deltachat-rpc-server` stderr |
| `DC_SIM_DEBUG` | — | Set `1` to unmute simulator `deltachat-rpc-server` stderr |
| `DC_HELP_SMOKE` | — | Set `1` to opt into the help-phrase live smoke (`help-phrases.test.ts`, #138; multi-turn, ~1 Anthropic turn per case) |
| `DC_HELP_SMOKE_FILTER` | — | Substring filter narrowing the help-phrase smoke to matching case ids, e.g. `list-agents` for a single-case paid probe |

## Account state

By default the harness wipes `.fixtures/` on every run to exercise the
full fresh-pair path (the scenario most prone to regressions).

Set `DC_REUSE_ACCOUNTS=1` to keep both sides' DC account state across
runs — useful when iterating on a specific test without re-pairing.

```bash
DC_INTEGRATION_TEST=1 DC_REUSE_ACCOUNTS=1 bun run test:integration
```

Wipe manually if the relay has reaped the accounts or the on-disk schema changed:

```bash
rm -rf plugin/test/integration/.fixtures/
```

## Public-chatmail opt-in

To run against the real `nine.testrun.org` (rarely needed — the handshake
is known to be slow; see the design doc):

```bash
DC_INTEGRATION_TEST=1 DC_TEST_RELAY=nine.testrun.org bun run test:integration
```

Expect this to be flaky. The pair timeout is 90s; the public relay has
completed handshakes in < 10s and in > 6 minutes in the same session.

## What's covered

Slice 1 (`pairing.test.ts`):

- **Pairing.** Real `dc_access_arm_pairing` → `dc_invite_link` →
  client-side `secureJoin` → welcome message arrives → extract code →
  `dc_access_pair`. Asserts the dispatcher writes its
  `approved/<chatId>` record.
- **Dispatcher → sim text.** Dispatcher posts via the `reply` MCP tool;
  client-sim receives via the `IncomingMsg` event.
- **Sim → dispatcher text.** Client-sim sends via
  `miscSendTextMessage`; dispatcher's `dc_chat_history` shows the
  message in the paired chat.

Slice 2 (`subagent-lifecycle.test.ts`) — **opt-in via `DC_TEST_SUBAGENT=1`**:

- **Subagent cold-spawn + reply.** Sim sends a message into the paired
  chat; dispatcher's `IncomingMsg` handler routes through
  `SubagentCache`; a real `claude -p` subagent spawns; first turn
  produces a reply via the `reply` tool; sim observes the reply.
  Costs ~1 Anthropic turn per run — credentials inherited from the
  parent process env.

Slice 3 (`help-phrases.test.ts`) — **opt-in via `DC_HELP_SMOKE=1`** (also
requires `DC_TEST_SUBAGENT=1`): drives every t2-tier journey annotated in
`help-content.ts` through a real subagent turn, one phrase per case, and
confirms the expected tool call or reply landed — the mutating cases
(`switch-agent`, `delete-agent`, `teleport-out`) are quarantined at the
end of the run so an earlier failure is never masked by a rebind or
disconnect.

Future slices:

- Subagent idle eviction + `--resume` (the warm-respawn path).
- Scheduler armed-timer firing a synthetic turn.
- Group-chat `senderAddr` owner verification (drop non-owner WebXDC
  updates).
- Voice transcription pipeline.
- Agent YAML import.

## CI cadence

Per the e2e spec: **on release cut**, not on every push. Tier 1
(`test:webxdc`) and the default `bun test` suite cover the fast
feedback loop. Docker-in-CI is out of scope for now.
