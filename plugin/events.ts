/**
 * Structured JSONL logs of DC runtime events.
 *
 * Streams (each one line per event, one file per UTC day):
 *   $DC_EVENT_DIR/tools-<YYYY-MM-DD>.log — every DC tool call
 *   $DC_EVENT_DIR/turns-<YYYY-MM-DD>.log — every subagent turn
 *   $DC_EVENT_DIR/permissions-<YYYY-MM-DD>.log — every permission decision
 *   $DC_EVENT_DIR/webxdc-<YYYY-MM-DD>.log       — every inbound WebXDC update
 *   $DC_EVENT_DIR/subagent-stderr-<YYYY-MM-DD>.log — raw subagent stderr +
 *     exit code (crash forensics — without this the cache only sees "died
 *     during send" with no signal/exitcode/trace to explain why)
 *   $DC_EVENT_DIR/permission-relay-<YYYY-MM-DD>.log — a PreToolUse relay
 *     attempt (permission-hook.sh / permission-hook-client.ts) that failed
 *     to reach a verdict at all. Distinct from `permissions`, which only
 *     ever records a *completed* round-trip — a hung/timed-out/erroring
 *     relay call never reaches that stream. Added after the 2026-08-03/04
 *     outage, where every Bash/WebFetch call silently timed out with
 *     nothing durable left behind to explain why.
 * (default dir: $DC_STATE_DIR/events/ or ~/.claude/channels/deltachat/events/).
 *
 * Filename uses the UTC date at write time; rotation happens implicitly
 * when the date rolls over (no in-process rotation, no mid-day churn).
 *
 * Sync append (~0.1-2ms typical) is fine: tool/turn runtimes dominate. The
 * logger swallows its own errors — observability must never kill the
 * caller. On any write failure the event is dropped and a debug line is
 * written to the normal log.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ToolCallEvent {
  /** ISO 8601 UTC timestamp. */
  ts: string
  /** Whether the call came from the terminal CC session or a subagent. */
  source: 'subagent' | 'terminal'
  /** Raw tool name. */
  tool: string
  /** Chat the subagent is bound to. Null for terminal calls. */
  callerChatId: number | null
  /** Owner contact of the caller chat. Null if legacy/terminal. */
  callerContactId: number | null
  /** `chat_id` argument if present (the chat the tool is acting on). */
  argChatId: number | null
  /** Owner contact of the target chat, if different from caller. */
  targetOwner: number | null
  /** Tool runtime in ms. */
  durationMs: number
  /** True iff no throw and the tool result did not set isError. */
  ok: boolean
  /**
   * Categorical error code when !ok. See the socket server and server.ts
   * terminal handler for the canonical set: rate_limited, unknown_tool,
   * tool_crash, chat_mismatch, install_pending, tool_error.
   */
  errorCode: string | null
  /**
   * Single-line stringified args with sensitive fields redacted. Capped
   * at 120 chars so the line stays easy to scan.
   */
  argPreview: string
  /**
   * Turn this tool call belongs to. Populated for subagent calls when the
   * dispatcher has an in-flight turn; null for terminal calls (no turn
   * concept) and for subagent calls that arrive outside a turn window
   * (e.g. permission auto-approve replay).
   */
  turnId?: string | null
  /**
   * Capability the tool annotation declares it requires (v1.3 slice 3).
   * Null when the tool isn't annotated; absent on records older than v1.3.
   */
  requiredCapability?: string | null
  /**
   * Resolved capability bundle of the originator at call time. `["*"]` for
   * terminal calls (the terminal IS the subscriber); `[]` for unknown
   * contacts; otherwise the contact's role bundle or explicit override.
   */
  originatorCapabilities?: string[]
  /**
   * Slice 3: `allow` if the originator's bundle covers the required
   * capability, `would_deny` if it doesn't. Pure observability — slice 4
   * flips `would_deny` to a hard refuse.
   */
  capabilityDecision?: 'allow' | 'would_deny'
}

/** Taxonomy of subagent turn exit reasons. See plans/2026-04-20-slices-2-5-decisions.md. */
export type TurnExitReason =
  | 'completed'
  | 'idle'
  | 'lru_evict'
  | 'turn_timeout'
  | 'crash'
  | 'user_abort'
  | 'resume_fallback'

export interface TurnEvent {
  /** ISO 8601 UTC timestamp at turn start. */
  ts: string
  /** Unique id assigned when the turn begins (see SubagentCache.runNow). */
  turnId: string
  /** Chat this turn ran in. */
  chatId: number
  /** Bound agent id (reads binding at emit time). Null if binding went away. */
  agentId: string | null
  /** Claude session UUID used for this turn. Null if unavailable. */
  sessionId: string | null
  /** Spawn cost absorbed by this turn — 0 for cache-hit turns. */
  spawnColdMs: number
  /** Wall-clock duration of the turn (start of runNow → completion/throw). */
  durationMs: number
  /** Count of DC tool calls routed through the dispatcher during this turn. */
  toolCalls: number
  exitReason: TurnExitReason
}

/**
 * Arg keys whose value is replaced with <redacted> in argPreview. Applied
 * to top-level keys only; we never log nested contents.
 */
const REDACT_KEYS = new Set([
  'text',
  'content',
  'body',
  'secret',
  'password',
  'token',
  'email',
])

const DEFAULT_DIR = process.env.DC_EVENT_DIR
  ?? (process.env.DC_STATE_DIR
    ? join(process.env.DC_STATE_DIR, 'events')
    : join(homedir(), '.claude', 'channels', 'deltachat', 'events'))

let _eventDir = DEFAULT_DIR

export function getEventDir(): string { return _eventDir }

export function setEventDir(dir: string): void { _eventDir = dir }

/**
 * Build the per-day file path for a given stream prefix. UTC so log lines
 * are monotonic across timezones and daylight-savings transitions.
 */
function pathForDate(stream: string, d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return join(_eventDir, `${stream}-${y}-${m}-${day}.log`)
}

/**
 * Format args as `k1=v1 k2=v2`, redacting sensitive keys and truncating
 * at 120 chars. Non-string values are coerced via String(); objects get
 * their JSON.stringify, clipped.
 */
export function buildArgPreview(args: Record<string, unknown> | null | undefined): string {
  if (!args || typeof args !== 'object') return ''
  const parts: string[] = []
  for (const [k, v] of Object.entries(args)) {
    if (REDACT_KEYS.has(k)) {
      parts.push(`${k}=<redacted>`)
      continue
    }
    let s: string
    if (v === null || v === undefined) s = String(v)
    else if (typeof v === 'string') s = v
    else if (typeof v === 'number' || typeof v === 'boolean') s = String(v)
    else {
      try { s = JSON.stringify(v) } catch { s = '<unserializable>' }
    }
    // Keep per-value length sane so one long field doesn't eat the whole preview.
    if (s.length > 40) s = s.slice(0, 37) + '...'
    parts.push(`${k}=${s}`)
  }
  const joined = parts.join(' ')
  return joined.length > 120 ? joined.slice(0, 117) + '...' : joined
}

function appendLine(stream: string, ts: string, payload: unknown, onWriteError?: (err: unknown) => void): void {
  try {
    mkdirSync(_eventDir, { recursive: true })
    appendFileSync(pathForDate(stream, new Date(ts)), JSON.stringify(payload) + '\n')
  } catch (err) {
    onWriteError?.(err)
  }
}

/**
 * Append one tool-call event line. Swallows errors — observability must
 * never affect tool execution.
 */
export function logToolCall(
  ev: ToolCallEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('tools', ev.ts, ev, onWriteError)
}

/** Append one subagent-turn event line. Swallows errors, like logToolCall. */
export function logTurn(
  ev: TurnEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('turns', ev.ts, ev, onWriteError)
}

/** Final decision on a permission prompt. */
export type PermissionVerdict = 'allow' | 'deny'

/**
 * Why the verdict was reached.
 *   user_allow / user_deny       — the owner tapped Allow or Deny in the WebXDC card
 *   skip_auto                    — bypassed by skip-permissions mode (no user prompt)
 *   capability_deny              — v1.3 capability gate refused the call:
 *                                  originator's bundle didn't cover the tool's
 *                                  requiresCapability annotation
 *   capability_lookup_error      — v1.3 capability gate fail-closed on a
 *                                  principal-store error (corrupt JSON, EACCES,
 *                                  etc.). Same outcome as deny; the separate
 *                                  reason makes the operator's `jq` queries
 *                                  honest about what actually failed.
 */
export type PermissionReason =
  | 'user_allow'
  | 'user_deny'
  | 'skip_auto'
  | 'capability_deny'
  | 'capability_lookup_error'
  | 'capability_invalid_requestor'

export interface PermissionEvent {
  ts: string
  chatId: number
  agentId: string | null
  tool: string
  /** Redacted, clipped stringification of the tool's input — same rules as argPreview. */
  inputPreview: string
  verdict: PermissionVerdict
  reason: PermissionReason
  /** True iff the dispatcher gave up waiting and defaulted to deny. */
  timedOut: boolean
  /** Wall-clock ms from prompt arrival to verdict (0 for skip_auto). */
  durationMs: number
  /** v1.3 capability gate: contact whose caps were checked (null for terminal). */
  originatorContactId?: number | null
  /** v1.3 capability gate: capability the tool annotation declared. */
  requiredCapability?: string
  /** v1.3 capability gate: originator's resolved bundle at the moment of decision. */
  originatorCapabilities?: string[]
}

/** Append one permission-decision event line. Swallows errors. */
export function logPermission(
  ev: PermissionEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('permissions', ev.ts, ev, onWriteError)
}

export interface WebXDCEvent {
  ts: string
  /** Message id hosting the WebXDC app. */
  msgId: number
  /** Chat the update arrived in. */
  chatId: number
  /** Registered app id (e.g. 'permissions', 'file-reviewer'); null for updates routed to unregistered msgIds. */
  appId: string | null
  /** Whether the update passed owner verification (false for group-chat updates from non-owners). */
  ownerVerified: boolean
  /** `payload.type` convention used by dc-claude-channel apps; null when absent. */
  payloadType: string | null
  /** Serialized payload byte length (UTF-8). 0 when payload is null. */
  payloadSize: number
}

/** Append one inbound-WebXDC-update event line. Swallows errors. */
export function logWebXDC(
  ev: WebXDCEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('webxdc', ev.ts, ev, onWriteError)
}

/**
 * Why a role was assigned to a contact (v1.3 slice 6).
 *   terminal_pair — recordContactPair fired during /deltachat:setup;
 *                   role is always `subscriber` for this path.
 *   picked        — subscriber explicitly chose the role via the XDC
 *                   picker (slice 7).
 *   tool          — dc_set_contact_role, the authenticated chat-message
 *                   path (#133); assigner is the capability-gated sender.
 */
export type RoleAssignmentReason = 'terminal_pair' | 'picked' | 'tool'

export interface RoleAssignmentEvent {
  ts: string
  /**
   * Contact whose role was set/changed. Required.
   */
  assigneeContactId: number
  /**
   * Role assigned (subscriber / trusted-agent / family-member / untrusted-agent / guest).
   */
  assignedRole: string
  /**
   * Previous role on disk, or null if this is a fresh assignment
   * (no principal record existed, or record had no role field).
   */
  previousRole: string | null
  /**
   * The actor responsible for the assignment. For `terminal_pair`,
   * null (the terminal session is implicit). For `picked`, the
   * subscriber's contactId who drove the XDC picker.
   */
  assignerContactId: number | null
  reason: RoleAssignmentReason
}

/**
 * Append one role-assignment event line. Same write discipline as the
 * other event streams — swallows errors, observability never affects
 * the caller. Lands in the same `permissions-<date>.log` stream as the
 * existing capability-deny entries; an operator running
 * `jq 'select(.assignedRole)'` filters role events.
 */
export function logRoleAssignment(
  ev: RoleAssignmentEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('permissions', ev.ts, ev, onWriteError)
}

export interface AutoPairDenialEvent {
  ts: string
  type: 'auto_pair_denied'
  chatId: number
  contactId: number
  role: string
}

export function logAutoPairDenial(ev: AutoPairDenialEvent): void {
  appendLine('permissions', ev.ts, ev)
}

/**
 * One emission of raw bytes from a subagent's claude stderr, plus an
 * `exit` marker when the process exits.
 *
 * Background. Pre-2026-05-31 the dispatcher fed subagent stderr through
 * a debug-namespace logger that only printed when DEBUG was set; in
 * production those bytes vanished. When a subagent's claude binary
 * crashed mid-turn the cache logged "subagent died during send" but no
 * exit code or panic message — root-cause investigation was guesswork.
 * This stream captures the trace to disk so the next crash leaves
 * forensic evidence.
 *
 * Lines may be partial — the stderr stream isn't line-buffered at the
 * source. We don't split here either; downstream `jq` can join by
 * subagentId if needed.
 */
export interface SubagentStderrEvent {
  ts: string
  /** Chat the subagent is bound to. */
  chatId: number
  /** Per-spawn subagent id (the `sub-<chatId>-<rand>` pattern). */
  subagentId: string
  /** Either a `stderr` chunk or an `exit` marker. */
  kind: 'stderr' | 'exit'
  /** stderr text for kind=stderr; empty for kind=exit. */
  text?: string
  /** Process exit code for kind=exit; null when the process was killed by signal. */
  exitCode?: number | null
}

export function logSubagentStderr(
  ev: SubagentStderrEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('subagent-stderr', ev.ts, ev, onWriteError)
}

/**
 * Where a PreToolUse relay attempt (permission-hook.sh /
 * permission-hook-client.ts) gave up before reaching a verdict.
 *
 *   missing_env                  — required DC_* env vars absent (client
 *                                  never attempted a connection)
 *   socket_error                 — `net.connect` failed or the socket
 *                                  emitted an `error` event
 *   bad_hello_ack                — dispatcher replied to `hello` with
 *                                  something other than `helloAck`
 *   bad_verdict_reply            — dispatcher's reply to
 *                                  `permissionRequest` wasn't a matching
 *                                  `permissionVerdict`
 *   unexpected_exception         — any other throw inside the client's
 *                                  connect handler
 *   shell_timeout_or_unknown_rc  — permission-hook.sh observed a non-zero
 *                                  exit the client didn't self-report
 *                                  (most commonly `timeout`'s rc=124 —
 *                                  the client hung, e.g. mid-`connect`,
 *                                  and never reached its own error path)
 */
export type PermissionRelayFailureStage =
  | 'missing_env'
  | 'socket_error'
  | 'bad_hello_ack'
  | 'bad_verdict_reply'
  | 'unexpected_exception'
  | 'shell_timeout_or_unknown_rc'

export interface PermissionRelayFailureEvent {
  ts: string
  /** Request id assigned by permission-hook.sh (`p-<pid>-<rand>`). Null if unavailable. */
  requestId: string | null
  /** Bound chat id, when known. */
  chatId: number | null
  /** Subagent id, when known. */
  subagentId: string | null
  /** Tool being gated, when known (e.g. `Bash`, `WebFetch`). */
  tool: string | null
  /** Where the failure was detected. */
  stage: PermissionRelayFailureStage
  /** Process exit code — the client's own (10-14), `timeout`'s (124), or whatever the shell wrapper observed. */
  exitCode: number
  /** Free-text detail — error message or unexpected frame contents, clipped to 200 chars. */
  detail: string
}

/**
 * Append one permission-relay-failure event line. See
 * `PermissionRelayFailureStage` for what this stream captures and why
 * it's separate from `permissions` (which only ever sees a *completed*
 * round-trip). Swallows errors, like the other streams.
 */
export function logPermissionRelayFailure(
  ev: PermissionRelayFailureEvent,
  onWriteError?: (err: unknown) => void,
): void {
  appendLine('permission-relay', ev.ts, ev, onWriteError)
}
