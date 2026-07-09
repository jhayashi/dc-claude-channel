/**
 * Dispatcher Unix-socket server.
 *
 * Accepts connections from (a) per-subagent tools-proxy MCP servers
 * forwarding DC tool calls, and (b) per-subagent PreToolUse hook
 * scripts forwarding permission requests.
 *
 * Every connection MUST send a valid `hello` frame as its first
 * message: the secret must match, the subagentId must be known to
 * the dispatcher, and the chatId must match the registry entry.
 * Any hello failure closes the connection with a `toolError` frame.
 *
 * After a successful hello, inbound frames are routed to onRequest
 * and the server writes the returned ServerMessage back on the same
 * connection.
 *
 * Permission requests in particular must be async — the handler
 * returns a Promise that the server awaits. This is how the
 * dispatcher blocks a hook connection while waiting for the user's
 * verdict from DC.
 */

import { createServer, type Server, type Socket } from 'node:net'
import { chmodSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import {
  parseClientFrame,
  encodeFrame,
  type ClientMessage,
  type ServerMessage,
  type ClientHello,
} from '../shared/protocol.js'

export interface SocketRequest {
  connectionId: string
  chatId: number
  subagentId: string
  role: 'tools' | 'hook'
  frame: Exclude<ClientMessage, ClientHello | { kind: 'bye' }>
}

export interface SocketServerOptions {
  path: string
  secret: string
  /** Returns whether this subagentId exists at all. */
  hasSubagent: (subagentId: string) => boolean
  /** Returns the chatId this subagentId is bound to, or null if unknown. */
  getSubagentChat: (subagentId: string) => number | null
  onRequest: (req: SocketRequest) => Promise<ServerMessage>
  logf?: (fmt: string, ...args: unknown[]) => void
}

interface Conn {
  id: string
  sock: Socket
  buf: string
  hello: ClientHello | null
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export class SocketServer {
  private server: Server | null = null
  private conns = new Map<string, Conn>()
  private nextConnId = 1
  /**
   * True only once this instance has successfully bound the socket path.
   * Guards stop() from unlinking a path this instance never created — a
   * duplicate server.ts that lost the singleton race constructs a
   * SocketServer but never calls start(), and its stop() must leave the
   * live dispatcher's socket intact (#127).
   */
  private bound = false

  constructor(private opts: SocketServerOptions) {}

  private log(fmt: string, ...args: unknown[]): void {
    this.opts.logf?.(fmt, ...args)
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.opts.path), { recursive: true })
    try { unlinkSync(this.opts.path) } catch {}
    this.server = createServer((sock) => this.onConnection(sock))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.opts.path, () => {
        try { chmodSync(this.opts.path, 0o600) } catch {}
        this.bound = true
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const conn of this.conns.values()) {
      try { conn.sock.destroy() } catch {}
    }
    this.conns.clear()
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()))
      this.server = null
    }
    // Only unlink a socket path this instance actually bound — never
    // remove the live dispatcher's socket from an unstarted duplicate (#127).
    if (this.bound) {
      try { unlinkSync(this.opts.path) } catch {}
      this.bound = false
    }
  }

  /** Send an out-of-band frame to a specific connection. */
  sendTo(connectionId: string, msg: ServerMessage): boolean {
    const conn = this.conns.get(connectionId)
    if (!conn || !conn.hello) return false
    conn.sock.write(encodeFrame(msg))
    return true
  }

  private onConnection(sock: Socket): void {
    const id = `c${this.nextConnId++}`
    const conn: Conn = { id, sock, buf: '', hello: null }
    this.conns.set(id, conn)

    sock.on('data', (chunk: Buffer) => {
      conn.buf += chunk.toString('utf-8')
      let nl: number
      while ((nl = conn.buf.indexOf('\n')) >= 0) {
        const line = conn.buf.slice(0, nl)
        conn.buf = conn.buf.slice(nl + 1)
        if (!line.trim()) continue
        this.onLine(conn, line).catch((err) => {
          this.log('socket-server: onLine crashed: %v', err)
        })
      }
    })
    sock.on('close', () => { this.conns.delete(id) })
    sock.on('error', () => { this.conns.delete(id) })
  }

  private writeError(conn: Conn, id: string, code: string, message: string): void {
    conn.sock.write(encodeFrame({ kind: 'toolError', id, error: { code, message } }))
  }

  private async onLine(conn: Conn, line: string): Promise<void> {
    const frame = parseClientFrame(line)
    if (!frame) {
      this.writeError(conn, 'unknown', 'parse', 'malformed or schema-invalid frame')
      return
    }

    if (frame.kind === 'bye') {
      conn.sock.end()
      return
    }

    if (frame.kind === 'hello') {
      if (!constantTimeEq(frame.secret, this.opts.secret)) {
        this.writeError(conn, 'hello', 'auth', 'bad secret')
        conn.sock.end()
        return
      }
      if (!this.opts.hasSubagent(frame.subagentId)) {
        this.writeError(conn, 'hello', 'unknown_subagent', 'subagentId not registered')
        conn.sock.end()
        return
      }
      const expectedChat = this.opts.getSubagentChat(frame.subagentId)
      if (expectedChat !== frame.chatId) {
        this.writeError(conn, 'hello', 'chat_mismatch', 'chatId does not match this subagent')
        conn.sock.end()
        return
      }
      conn.hello = frame
      conn.sock.write(encodeFrame({ kind: 'helloAck' }))
      return
    }

    if (!conn.hello) {
      const id = (frame as { id?: string }).id ?? 'unknown'
      this.writeError(conn, id, 'unauthenticated', 'hello required before tool calls')
      return
    }

    // Route to the owner
    try {
      const reply = await this.opts.onRequest({
        connectionId: conn.id,
        chatId: conn.hello.chatId,
        subagentId: conn.hello.subagentId,
        role: conn.hello.role,
        frame,
      })
      conn.sock.write(encodeFrame(reply))
    } catch (err) {
      const id = (frame as { id?: string }).id ?? 'unknown'
      this.writeError(conn, id, 'handler_crash', String(err))
    }
  }
}
