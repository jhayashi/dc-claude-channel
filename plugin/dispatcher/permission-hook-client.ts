#!/usr/bin/env bun
/**
 * Permission-hook client helper.
 *
 * Invoked by permission-hook.sh with one argument: the request id.
 * Reads Claude's PreToolUse JSON payload from stdin, connects to
 * the dispatcher's Unix socket, performs hello + permissionRequest,
 * and prints the verdict to stdout:
 *
 *   allow
 *   deny: <message>
 *
 * All socket/IO errors exit non-zero so the shell wrapper can
 * translate them to a deny. The shell wrapper applies the timeout;
 * this helper trusts its parent.
 */

import { connect } from 'node:net'
import {
  encodeFrame,
  parseServerFrame,
  type ServerMessage,
} from '../shared/protocol.js'
import { logPermissionRelayFailure, type PermissionRelayFailureStage } from '../events.js'

const REQUEST_ID = process.argv[2] ?? 'p-unknown'
const SOCKET = process.env.DC_DISPATCHER_SOCKET
const SECRET = process.env.DC_DISPATCHER_SECRET
const SUB_ID = process.env.DC_SUBAGENT_ID
const CHAT_ID = Number(process.env.DC_SUBAGENT_CHAT_ID ?? '0')

/**
 * Record a relay failure before exiting. Called from every error path
 * below so an outage like 2026-08-03/04 (every Bash/WebFetch call
 * silently timing out, no durable evidence of why) leaves a trail.
 * `tool` is best-effort — it's only known once stdin has parsed.
 */
function logFailure(stage: PermissionRelayFailureStage, exitCode: number, detail: string, tool?: string | null): void {
  logPermissionRelayFailure({
    ts: new Date().toISOString(),
    requestId: REQUEST_ID,
    chatId: Number.isFinite(CHAT_ID) && CHAT_ID !== 0 ? CHAT_ID : null,
    subagentId: SUB_ID ?? null,
    tool: tool ?? null,
    stage,
    exitCode,
    detail: detail.slice(0, 200),
  })
}

if (!SOCKET || !SECRET || !SUB_ID || !CHAT_ID) {
  console.error('permission-hook-client: missing env vars')
  logFailure('missing_env', 10, 'one or more of DC_DISPATCHER_SOCKET/DC_DISPATCHER_SECRET/DC_SUBAGENT_ID/DC_SUBAGENT_CHAT_ID missing')
  process.exit(10)
}

// Read stdin completely (Claude's tool_input JSON)
const chunks: Buffer[] = []
for await (const chunk of process.stdin as unknown as AsyncIterable<Buffer>) {
  chunks.push(chunk)
}
const payload = Buffer.concat(chunks).toString('utf-8').trim()
let parsed: { tool_name?: string; tool_input?: unknown } = {}
try {
  parsed = payload ? JSON.parse(payload) : {}
} catch {}

const sock = connect(SOCKET)

let buf = ''
const frameQueue: ServerMessage[] = []
const waiters: Array<(m: ServerMessage) => void> = []

sock.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf-8')
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    const f = parseServerFrame(line)
    if (!f) continue
    if (waiters.length) waiters.shift()!(f); else frameQueue.push(f)
  }
})

function readFrame(): Promise<ServerMessage> {
  if (frameQueue.length) return Promise.resolve(frameQueue.shift()!)
  return new Promise((r) => waiters.push(r))
}

sock.on('error', (err) => {
  console.error(`permission-hook-client: socket error: ${err.message}`)
  logFailure('socket_error', 11, err.message, parsed.tool_name)
  process.exit(11)
})

sock.on('connect', async () => {
  try {
    sock.write(encodeFrame({
      kind: 'hello',
      secret: SECRET!,
      role: 'hook',
      chatId: CHAT_ID,
      subagentId: SUB_ID!,
    }))
    const ack = await readFrame()
    if (ack.kind !== 'helloAck') {
      console.error(`permission-hook-client: unexpected ack: ${JSON.stringify(ack)}`)
      logFailure('bad_hello_ack', 12, JSON.stringify(ack), parsed.tool_name)
      process.exit(12)
    }

    sock.write(encodeFrame({
      kind: 'permissionRequest',
      id: REQUEST_ID,
      tool: parsed.tool_name ?? 'unknown',
      input: parsed.tool_input ?? {},
    }))
    const verdict = await readFrame()
    if (verdict.kind !== 'permissionVerdict' || verdict.id !== REQUEST_ID) {
      console.error(`permission-hook-client: unexpected reply: ${JSON.stringify(verdict)}`)
      logFailure('bad_verdict_reply', 13, JSON.stringify(verdict), parsed.tool_name)
      process.exit(13)
    }

    if (verdict.verdict === 'allow') {
      process.stdout.write('allow\n')
    } else {
      process.stdout.write(`deny: ${verdict.message ?? 'denied by user'}\n`)
    }
    sock.end()
    process.exit(0)
  } catch (err) {
    console.error(`permission-hook-client: ${err}`)
    logFailure('unexpected_exception', 14, err instanceof Error ? `${err.name}: ${err.message}` : String(err), parsed.tool_name)
    process.exit(14)
  }
})
