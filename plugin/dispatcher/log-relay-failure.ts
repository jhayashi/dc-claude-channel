#!/usr/bin/env bun
/**
 * Fallback logger invoked directly by permission-hook.sh (bash), not by
 * permission-hook-client.ts.
 *
 * permission-hook-client.ts logs its OWN error paths in-process
 * (exit codes 10-14, see logFailure() there). But the most likely real
 * failure mode — the one that actually matched the 2026-08-03/04 outage
 * symptom (every Bash/WebFetch call uniformly hanging) — is the client
 * getting stuck mid-`connect`/mid-`readFrame` and killed by the shell
 * wrapper's `timeout` (rc=124) before it ever reaches one of its own
 * `process.exit()` calls. In that case nothing in-process ever logs
 * anything. This script is the catch-all: permission-hook.sh calls it
 * whenever it sees an rc it doesn't recognize as one of the client's own
 * (10-14), so a hang still leaves a durable record behind.
 *
 * Deliberately does no socket I/O of its own — just a synchronous file
 * append — so it stays fast and reliable even during the exact outage
 * it exists to diagnose.
 *
 * Args: <requestId> <rc> <chatId> <subagentId> <tool> <detail>
 */

import { logPermissionRelayFailure } from '../events.js'

const [requestId, rcStr, chatIdStr, subagentId, tool, detail] = process.argv.slice(2)

const rc = Number(rcStr)
const chatId = Number(chatIdStr)

logPermissionRelayFailure({
  ts: new Date().toISOString(),
  requestId: requestId || null,
  chatId: Number.isFinite(chatId) && chatId !== 0 ? chatId : null,
  subagentId: subagentId || null,
  tool: tool || null,
  stage: 'shell_timeout_or_unknown_rc',
  exitCode: Number.isFinite(rc) ? rc : -1,
  detail: (detail || '').slice(0, 200),
})
