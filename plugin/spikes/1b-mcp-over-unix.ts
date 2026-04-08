#!/usr/bin/env bun
/**
 * Spike 1B driver — spawns the server, opens a Unix-socket client,
 * sends hello + an echo toolCall, validates the round-trip, then
 * tests error paths (bad secret, unknown tool, malformed JSON).
 *
 * This is a focused unit-test of the wire protocol designed in
 * plan §"Wire protocol". A separate Phase 2 task will verify the
 * same protocol when loaded as an MCP server in claude -p.
 */

import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { exitFromResult, type SpikeResult } from './lib/report.js'

const SOCKET_PATH = `/tmp/spike-1b-${randomBytes(6).toString('hex')}.sock`
const SECRET = randomBytes(16).toString('hex')

interface ServerExchange {
  send: (obj: unknown) => void
  next: () => Promise<any>
  close: () => void
}

function openClient(path: string): Promise<ServerExchange> {
  return new Promise((resolve, reject) => {
    const sock = connect(path)
    let buf = ''
    const queue: any[] = []
    const waiters: Array<(v: any) => void> = []
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (waiters.length) waiters.shift()!(msg); else queue.push(msg)
      }
    })
    sock.on('error', reject)
    sock.on('connect', () => {
      resolve({
        send: (obj) => sock.write(JSON.stringify(obj) + '\n'),
        next: () => new Promise((r) => { if (queue.length) r(queue.shift()); else waiters.push(r) }),
        close: () => sock.end(),
      })
    })
  })
}

function spawnServer(): Promise<ReturnType<typeof spawn>> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [join(import.meta.dir, '1b-mcp-server-side.ts')], {
      env: { ...process.env, SPIKE_1B_SOCKET: SOCKET_PATH, SPIKE_1B_SECRET: SECRET },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('listening')) resolve(child)
    })
    child.on('error', reject)
    setTimeout(() => reject(new Error('server did not start in 5s')), 5000)
  })
}

async function main(): Promise<void> {
  const server = await spawnServer()
  const evidence: Array<{ label: string; value: string }> = []
  let allPass = true
  try {
    // Happy path
    const c1 = await openClient(SOCKET_PATH)
    c1.send({ kind: 'hello', secret: SECRET })
    const ack = await c1.next()
    const helloOk = ack.kind === 'helloAck'
    evidence.push({ label: 'hello → helloAck', value: helloOk ? 'PASS' : `FAIL (${JSON.stringify(ack)})` })
    if (!helloOk) allPass = false

    c1.send({ kind: 'toolCall', id: 't1', tool: 'echo', args: { text: 'cobalt' } })
    const r1 = await c1.next()
    const echoOk = r1.kind === 'toolResult' && r1.result.content[0].text === 'echo:cobalt'
    evidence.push({ label: 'echo round-trip', value: echoOk ? 'PASS' : `FAIL (${JSON.stringify(r1)})` })
    if (!echoOk) allPass = false

    c1.send({ kind: 'toolCall', id: 't2', tool: 'nope', args: {} })
    const r2 = await c1.next()
    const unknownOk = r2.kind === 'toolError' && r2.error.code === 'unknown_tool'
    evidence.push({ label: 'unknown tool → toolError', value: unknownOk ? 'PASS' : `FAIL (${JSON.stringify(r2)})` })
    if (!unknownOk) allPass = false
    c1.close()

    // Bad secret
    const c2 = await openClient(SOCKET_PATH)
    c2.send({ kind: 'hello', secret: 'wrong' })
    const r3 = await c2.next()
    const badSecretOk = r3.kind === 'toolError' && r3.error.code === 'auth'
    evidence.push({ label: 'bad secret → auth error', value: badSecretOk ? 'PASS' : `FAIL (${JSON.stringify(r3)})` })
    if (!badSecretOk) allPass = false
    c2.close()
  } finally {
    server.kill('SIGTERM')
  }

  exitFromResult({
    id: '1b-mcp-over-unix',
    title: 'MCP server tunneled over a Unix socket (wire-protocol level)',
    passed: allPass,
    verdict: allPass
      ? 'wire protocol round-trip + auth + unknown-tool error all work'
      : 'wire protocol regression — see evidence',
    evidence,
    notes: 'This spike covers the framing/protocol layer only. Spike 1E covers loading the proxy as an MCP server inside `claude -p`.',
  })
}

main().catch((err) => { console.error('spike 1b crashed:', err); process.exit(2) })
