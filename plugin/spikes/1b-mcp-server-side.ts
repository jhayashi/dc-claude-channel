#!/usr/bin/env bun
/**
 * Spike 1B server side — listens on a Unix socket, accepts a single
 * "echo" tool call, and replies. Standalone process; spawned by
 * 1b-mcp-over-unix.ts.
 *
 * Wire format: newline-delimited JSON. One message per line.
 *
 * Client → server:
 *   {kind: "hello", secret}
 *   {kind: "toolCall", id, tool: "echo", args: {text}}
 *
 * Server → client:
 *   {kind: "helloAck"}
 *   {kind: "toolResult", id, result: {content: [{type: "text", text}]}}
 *   {kind: "toolError", id, error: {code, message}}
 */

import { createServer } from 'node:net'
import { unlinkSync, chmodSync } from 'node:fs'

const SOCKET_PATH = process.env.SPIKE_1B_SOCKET ?? '/tmp/spike-1b.sock'
const SECRET = process.env.SPIKE_1B_SECRET ?? 'test-secret'

try { unlinkSync(SOCKET_PATH) } catch {}

const server = createServer((conn) => {
  let buf = ''
  let helloOk = false
  conn.on('data', (chunk) => {
    buf += chunk.toString('utf-8')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch {
        conn.write(JSON.stringify({ kind: 'toolError', id: 'unknown', error: { code: 'parse', message: 'bad json' } }) + '\n')
        continue
      }
      if (msg.kind === 'hello') {
        if (msg.secret !== SECRET) {
          conn.write(JSON.stringify({ kind: 'toolError', id: 'hello', error: { code: 'auth', message: 'bad secret' } }) + '\n')
          conn.end()
          return
        }
        helloOk = true
        conn.write(JSON.stringify({ kind: 'helloAck' }) + '\n')
      } else if (msg.kind === 'toolCall' && helloOk) {
        if (msg.tool !== 'echo') {
          conn.write(JSON.stringify({ kind: 'toolError', id: msg.id, error: { code: 'unknown_tool', message: msg.tool } }) + '\n')
        } else {
          conn.write(JSON.stringify({
            kind: 'toolResult',
            id: msg.id,
            result: { content: [{ type: 'text', text: `echo:${msg.args.text}` }] },
          }) + '\n')
        }
      } else {
        conn.write(JSON.stringify({ kind: 'toolError', id: msg.id ?? 'unknown', error: { code: 'unauthenticated', message: 'hello first' } }) + '\n')
      }
    }
  })
})

server.listen(SOCKET_PATH, () => {
  chmodSync(SOCKET_PATH, 0o600)
  console.log(`spike-1b server listening on ${SOCKET_PATH}`)
})

process.on('SIGTERM', () => { server.close(); try { unlinkSync(SOCKET_PATH) } catch {}; process.exit(0) })
process.on('SIGINT',  () => { server.close(); try { unlinkSync(SOCKET_PATH) } catch {}; process.exit(0) })
