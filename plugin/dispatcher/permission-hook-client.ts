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

const REQUEST_ID = process.argv[2] ?? 'p-unknown'
const SOCKET = process.env.DC_DISPATCHER_SOCKET
const SECRET = process.env.DC_DISPATCHER_SECRET
const SUB_ID = process.env.DC_SUBAGENT_ID
const CHAT_ID = Number(process.env.DC_SUBAGENT_CHAT_ID ?? '0')

if (!SOCKET || !SECRET || !SUB_ID || !CHAT_ID) {
  console.error('permission-hook-client: missing env vars')
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
    process.exit(14)
  }
})
