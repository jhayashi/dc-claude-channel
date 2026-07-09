import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SocketServer, type SocketRequest } from '../dispatcher/socket-server.js'
import { encodeFrame, type ClientMessage, type ServerMessage } from '../shared/protocol.js'
import { logToolCall, getEventDir, setEventDir, buildArgPreview } from '../events.js'

function openClient(path: string): Promise<{ sock: Socket; read: () => Promise<unknown>; send: (m: ClientMessage) => void }> {
  return new Promise((resolve, reject) => {
    const sock = connect(path)
    let buf = ''
    const queue: unknown[] = []
    const waiters: Array<(v: unknown) => void> = []
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf-8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line) continue
        const m = JSON.parse(line)
        if (waiters.length) waiters.shift()!(m); else queue.push(m)
      }
    })
    sock.on('error', reject)
    sock.on('connect', () => {
      resolve({
        sock,
        read: () => new Promise((r) => { if (queue.length) r(queue.shift()); else waiters.push(r) }),
        send: (m) => sock.write(encodeFrame(m)),
      })
    })
  })
}

describe('SocketServer', () => {
  let dir: string
  let sockPath: string
  let secret: string
  let server: SocketServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sock-srv-'))
    sockPath = join(dir, 'd.sock')
    secret = randomBytes(16).toString('hex')
    server = new SocketServer({
      path: sockPath,
      secret,
      hasSubagent: (id) => id === 'sub-1',
      getSubagentChat: (id) => id === 'sub-1' ? 42 : null,
      onRequest: async () => ({ kind: 'toolResult', id: 'x', result: { content: [{ type: 'text', text: 'default' }] } } as ServerMessage),
    })
    await server.start()
  })

  afterEach(async () => {
    await server.stop()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('creates the socket file with 0600 mode', () => {
    expect(existsSync(sockPath)).toBe(true)
  })

  it('accepts a valid hello', async () => {
    const c = await openClient(sockPath)
    c.send({ kind: 'hello', secret, role: 'hook', chatId: 42, subagentId: 'sub-1' })
    const ack = await c.read()
    expect((ack as { kind: string }).kind).toBe('helloAck')
    c.sock.end()
  })

  it('rejects bad secret', async () => {
    const c = await openClient(sockPath)
    c.send({ kind: 'hello', secret: 'wrong', role: 'hook', chatId: 42, subagentId: 'sub-1' })
    const err = await c.read()
    expect((err as { kind: string; error: { code: string } }).kind).toBe('toolError')
    expect((err as { error: { code: string } }).error.code).toBe('auth')
  })

  it('rejects unknown subagent', async () => {
    const c = await openClient(sockPath)
    c.send({ kind: 'hello', secret, role: 'hook', chatId: 42, subagentId: 'nope' })
    const err = await c.read()
    expect((err as { kind: string; error: { code: string } }).error.code).toBe('unknown_subagent')
  })

  it('rejects chatId mismatch for a known subagent', async () => {
    const c = await openClient(sockPath)
    c.send({ kind: 'hello', secret, role: 'hook', chatId: 9999, subagentId: 'sub-1' })
    const err = await c.read()
    expect((err as { kind: string; error: { code: string } }).error.code).toBe('chat_mismatch')
  })

  it('routes toolCall through onRequest after hello', async () => {
    const received: SocketRequest[] = []
    server = new SocketServer({
      path: sockPath + '.2',
      secret,
      hasSubagent: () => true,
      getSubagentChat: () => 1,
      onRequest: async (req) => {
        received.push(req)
        return { kind: 'toolResult', id: req.frame.kind === 'toolCall' ? req.frame.id : 'x', result: { content: [{ type: 'text', text: 'routed' }] } }
      },
    })
    await server.start()
    const c = await openClient(sockPath + '.2')
    c.send({ kind: 'hello', secret, role: 'tools', chatId: 1, subagentId: 'anything' })
    await c.read() // ack
    c.send({ kind: 'toolCall', id: 't1', tool: 'dc_send', args: { chat_id: '1', text: 'hi' } })
    const res = await c.read()
    expect((res as { kind: string }).kind).toBe('toolResult')
    expect(received.length).toBe(1)
    c.sock.end()
    await server.stop()
  })

  it('stop() on an unstarted duplicate does not unlink the live socket (#127)', async () => {
    // A second server.ts that loses the singleton race constructs a
    // SocketServer but never calls start(); on shutdown its stop() must
    // NOT remove the live dispatcher's socket path.
    expect(existsSync(sockPath)).toBe(true)
    const duplicate = new SocketServer({
      path: sockPath,
      secret,
      hasSubagent: () => false,
      getSubagentChat: () => null,
      onRequest: async () => ({ kind: 'toolResult', id: 'x', result: { content: [{ type: 'text', text: 'x' }] } } as ServerMessage),
    })
    await duplicate.stop()
    // The live server's socket path must survive, and it must still serve.
    expect(existsSync(sockPath)).toBe(true)
    const c = await openClient(sockPath)
    c.send({ kind: 'hello', secret, role: 'hook', chatId: 42, subagentId: 'sub-1' })
    const ack = await c.read()
    expect((ack as { kind: string }).kind).toBe('helloAck')
    c.sock.end()
  })

  it('rejects toolCall before hello', async () => {
    const c = await openClient(sockPath)
    c.send({ kind: 'toolCall', id: 't1', tool: 'dc_send', args: {} })
    const err = await c.read()
    expect((err as { kind: string; error: { code: string } }).error.code).toBe('unauthenticated')
  })

  it('rejects malformed JSON', async () => {
    const c = await openClient(sockPath)
    c.sock.write('not json\n')
    const err = await c.read()
    expect((err as { kind: string; error: { code: string } }).error.code).toBe('parse')
  })

  it('logs tool calls to the event log when onRequest invokes logToolCall', async () => {
    // Simulates the server.ts wiring: onRequest runs the tool and emits a
    // ToolCallEvent. End-to-end asserts the JSONL line lands on disk.
    const eventDir = mkdtempSync(join(tmpdir(), 'sock-evt-'))
    const prevDir = getEventDir()
    setEventDir(eventDir)
    try {
      server = new SocketServer({
        path: sockPath + '.evt',
        secret,
        hasSubagent: () => true,
        getSubagentChat: () => 7,
        onRequest: async (req) => {
          if (req.frame.kind !== 'toolCall') {
            return { kind: 'toolError', id: 'x', error: { code: 'unhandled', message: req.frame.kind } }
          }
          const start = Date.now()
          logToolCall({
            ts: new Date().toISOString(),
            source: 'subagent',
            tool: req.frame.tool,
            callerChatId: req.chatId,
            callerContactId: null,
            argChatId: 7,
            targetOwner: null,
            durationMs: Date.now() - start,
            ok: true,
            errorCode: null,
            argPreview: buildArgPreview(req.frame.args as Record<string, unknown>),
          })
          return { kind: 'toolResult', id: req.frame.id, result: { content: [{ type: 'text', text: 'ok' }] } }
        },
      })
      await server.start()
      const c = await openClient(sockPath + '.evt')
      c.send({ kind: 'hello', secret, role: 'tools', chatId: 7, subagentId: 'sub-7' })
      await c.read() // ack
      c.send({ kind: 'toolCall', id: 'ev1', tool: 'dc_status', args: { chat_id: '7' } })
      const res = await c.read()
      expect((res as { kind: string }).kind).toBe('toolResult')
      const files = readdirSync(eventDir)
      expect(files.length).toBe(1)
      const lines = readFileSync(join(eventDir, files[0]), 'utf-8').split('\n').filter(Boolean)
      expect(lines.length).toBe(1)
      const parsed = JSON.parse(lines[0])
      expect(parsed.tool).toBe('dc_status')
      expect(parsed.source).toBe('subagent')
      expect(parsed.callerChatId).toBe(7)
      expect(parsed.ok).toBe(true)
      c.sock.end()
      await server.stop()
    } finally {
      setEventDir(prevDir)
      try { rmSync(eventDir, { recursive: true, force: true }) } catch {}
    }
  })
})
