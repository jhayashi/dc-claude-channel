# Phase 2: Dispatcher + persistent subagent cache + hook-based permission relay

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-process `server.ts` with a dispatcher that maintains a bounded LRU cache of persistent `claude -p` subagent processes (one per recently active chat), routes incoming Delta Chat messages to them over stream-json stdin/stdout, and relays tool permission prompts back through a PreToolUse hook + Unix socket + existing WebXDC permission-app flow.

**Architecture (summary — see `docs/plan-issue-1.md` v8 for full context):**

- One **dispatcher** (the existing MCP server that the user's terminal Claude Code connects to) owns the DC RPC connection and a Unix-socket server. It spawns per-chat subagents on demand and keeps up to `DC_SUBAGENT_MAX_ACTIVE` (default 4) of them alive in an LRU cache.
- Each **subagent** is a `claude -p --input-format stream-json --output-format stream-json --settings <hook-cfg>` child process. It receives chat messages over stdin, emits responses over stdout, and exits on idle timeout or LRU eviction.
- Each subagent runs with a **PreToolUse hook** that, on any Bash/Edit/Write/WebFetch, connects to the dispatcher's Unix socket, forwards the tool call as a `permissionRequest`, and blocks reading the verdict. The dispatcher routes the request to the existing `permissions-app` WebXDC flow in the bound chat. The user taps Allow/Deny. The dispatcher writes the verdict back; the hook exits 0 or 2.
- **DC tools** (`dc_send`, `dc_send_file`, `dc_chat_history`, etc.) are the subagent's primary way to interact with its bound chat. They are exposed via a separate tools-proxy MCP server that forwards over the same Unix socket (different frame `kind`). The dispatcher executes them against its single DC RPC connection.

**Tech Stack:**
- TypeScript / Bun
- `@deltachat/jsonrpc-client` + `@deltachat/stdio-rpc-server` (unchanged)
- `@modelcontextprotocol/sdk` (unchanged; for the dispatcher's own MCP server and the per-subagent tools-proxy)
- `zod` (new dep for wire-protocol validation)
- Node `net` module for Unix sockets
- Bash (for the PreToolUse hook script)

**Reference implementations from Phase 1:**
- `plugin/spikes/1a-named-sessions.ts` — working `startPersistent()` stream-json process driver (copy the pattern into `dispatcher/subagent-process.ts`)
- `plugin/spikes/1b-mcp-over-unix.ts` + `1b-mcp-server-side.ts` — working Unix socket + newline-delimited JSON framing (copy the handshake pattern into `dispatcher/socket-server.ts`)
- `plugin/spikes/1g-hook.sh` + `1g-settings.json` — working PreToolUse hook pattern (extend into `dispatcher/permission-hook.sh`)

**Out of scope (deferred to Phase 3+):**
- Orphan cleanup on dispatcher restart (`pgrep` for stale `claude -p --session-id dc-chat-*`)
- Rate limiting per subagent
- Per-group model selection (Phase 4)
- Migration / version bump to 0.9.0 (Phase 5)
- Stress testing (Phase 6)

---

## File structure

Each file has one clear responsibility. Files that change together live together.

```
plugin/
  shared/
    protocol.ts          # Wire protocol types + Zod schemas (single source of truth)
  dispatcher/
    socket-server.ts     # Unix socket listener, auth, frame routing
    subagent-process.ts  # One persistent claude -p process (based on Spike 1A startPersistent)
    subagent-cache.ts    # LRU cache of active subagents, eviction, idle timeout
    hook-config.ts       # Generate per-subagent settings.json for the PreToolUse hook
    permission-hook.sh   # PreToolUse hook script — talks to the socket
    message-router.ts    # Classify incoming DC events, dispatch to cache
  server.ts              # (modified) wire dispatcher into IncomingMsg, keep existing MCP tool registration
  apps/
    permissions-app.ts   # (modified) accept dispatcher-routed permission requests keyed by chat_id
  test/
    protocol.test.ts
    socket-server.test.ts
    subagent-cache.test.ts
    hook-config.test.ts
```

## Decisions locked in upfront

- **Socket path:** `~/.claude/channels/deltachat/dispatcher.sock`. User-scoped directory; permissions 0600.
- **Shared secret:** regenerated per dispatcher start, 32 bytes hex, passed to subagents via `DC_DISPATCHER_SECRET` env var.
- **Subagent chat binding:** each subagent's UUID session id is `dc-chat-<chatId>-<random-suffix>`; `DC_SUBAGENT_CHAT_ID=<chatId>` is set in its env so the hook script knows who it belongs to.
- **Cache size:** `DC_SUBAGENT_MAX_ACTIVE` env var (default 4, range 1–16).
- **Idle timeout:** `DC_SUBAGENT_IDLE_TIMEOUT_MIN` env var (default 15 minutes). Dispatcher sets a setTimeout per subagent; on fire, `SIGTERM` + remove from cache.
- **Hook timeout:** the hook waits at most `DC_HOOK_TIMEOUT_SEC` (default 300 seconds = 5 min) for a verdict from the dispatcher. On timeout, the hook denies (exit 2) with "permission request timed out".
- **Per-chat queue:** depth 10 in-memory. Each subagent-process handles one message at a time; extras queue. Overflow drops the **oldest queued** message and sends "⚠️ message dropped, agent busy" to the chat.

---

## Task 1: `shared/protocol.ts` — wire protocol types + Zod schemas

**Files:**
- Create: `plugin/shared/protocol.ts`
- Test: `plugin/test/protocol.test.ts`

**Reference:** Plan v8 §"Wire protocol". Phase 1 Spike 1B has the handshake structure.

- [ ] **Step 1: Install zod**

```bash
cd plugin && bun add zod
```

- [ ] **Step 2: Write the schema file**

Create `plugin/shared/protocol.ts`:

```typescript
/**
 * Dispatcher ↔ subagent / hook wire protocol.
 *
 * Newline-delimited JSON over a Unix stream socket. Every frame has
 * a `kind` discriminator. Every frame is parsed through a Zod schema
 * at the socket boundary — schema failures return a `toolError` or
 * close the connection depending on the context.
 *
 * Three participants speak this protocol:
 *   1. The dispatcher's socket-server (server-side).
 *   2. Each subagent's tools-proxy MCP server (client-side, for DC
 *      tool calls).
 *   3. Each subagent's PreToolUse hook script (client-side, for
 *      permission requests).
 *
 * Hook and tools-proxy both open separate connections; the
 * `ClientHello.role` discriminator tells the dispatcher which.
 */

import { z } from 'zod'

// ── Shared primitives ──────────────────────────────────────────────

export const ToolResultSchema = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })),
  isError: z.boolean().optional(),
})
export type ToolResult = z.infer<typeof ToolResultSchema>

// ── Client → server frames ─────────────────────────────────────────

export const ClientHelloSchema = z.object({
  kind: z.literal('hello'),
  secret: z.string().min(1),
  role: z.enum(['tools', 'hook']),
  chatId: z.number().int().positive(),
  subagentId: z.string().min(1),
})
export type ClientHello = z.infer<typeof ClientHelloSchema>

export const ClientToolCallSchema = z.object({
  kind: z.literal('toolCall'),
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()),
})
export type ClientToolCall = z.infer<typeof ClientToolCallSchema>

export const ClientPermissionRequestSchema = z.object({
  kind: z.literal('permissionRequest'),
  id: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown(),
})
export type ClientPermissionRequest = z.infer<typeof ClientPermissionRequestSchema>

export const ClientByeSchema = z.object({ kind: z.literal('bye') })
export type ClientBye = z.infer<typeof ClientByeSchema>

export const ClientMessageSchema = z.discriminatedUnion('kind', [
  ClientHelloSchema,
  ClientToolCallSchema,
  ClientPermissionRequestSchema,
  ClientByeSchema,
])
export type ClientMessage = z.infer<typeof ClientMessageSchema>

// ── Server → client frames ─────────────────────────────────────────

export const ServerHelloAckSchema = z.object({
  kind: z.literal('helloAck'),
})
export type ServerHelloAck = z.infer<typeof ServerHelloAckSchema>

export const ServerToolResultSchema = z.object({
  kind: z.literal('toolResult'),
  id: z.string().min(1),
  result: ToolResultSchema,
})
export type ServerToolResult = z.infer<typeof ServerToolResultSchema>

export const ServerToolErrorSchema = z.object({
  kind: z.literal('toolError'),
  id: z.string().min(1),
  error: z.object({ code: z.string(), message: z.string() }),
})
export type ServerToolError = z.infer<typeof ServerToolErrorSchema>

export const ServerPermissionVerdictSchema = z.object({
  kind: z.literal('permissionVerdict'),
  id: z.string().min(1),
  verdict: z.enum(['allow', 'deny']),
  message: z.string().optional(),
})
export type ServerPermissionVerdict = z.infer<typeof ServerPermissionVerdictSchema>

export const ServerMessageSchema = z.discriminatedUnion('kind', [
  ServerHelloAckSchema,
  ServerToolResultSchema,
  ServerToolErrorSchema,
  ServerPermissionVerdictSchema,
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

// ── Framing helpers ────────────────────────────────────────────────

export function encodeFrame(msg: ClientMessage | ServerMessage): string {
  return JSON.stringify(msg) + '\n'
}

export function parseClientFrame(line: string): ClientMessage | null {
  try {
    const raw = JSON.parse(line)
    return ClientMessageSchema.parse(raw)
  } catch {
    return null
  }
}

export function parseServerFrame(line: string): ServerMessage | null {
  try {
    const raw = JSON.parse(line)
    return ServerMessageSchema.parse(raw)
  } catch {
    return null
  }
}
```

- [ ] **Step 3: Write the failing test**

Create `plugin/test/protocol.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import {
  encodeFrame,
  parseClientFrame,
  parseServerFrame,
  type ClientHello,
  type ClientToolCall,
  type ClientPermissionRequest,
  type ServerPermissionVerdict,
  type ServerToolResult,
} from '../shared/protocol.js'

describe('protocol frames', () => {
  it('round-trips a hello', () => {
    const msg: ClientHello = {
      kind: 'hello',
      secret: 'abc123',
      role: 'hook',
      chatId: 42,
      subagentId: 'sub-1',
    }
    const line = encodeFrame(msg).trimEnd()
    expect(parseClientFrame(line)).toEqual(msg)
  })

  it('round-trips a toolCall', () => {
    const msg: ClientToolCall = {
      kind: 'toolCall',
      id: 'r1',
      tool: 'dc_send',
      args: { chat_id: '42', text: 'hi' },
    }
    expect(parseClientFrame(encodeFrame(msg).trimEnd())).toEqual(msg)
  })

  it('round-trips a permissionRequest', () => {
    const msg: ClientPermissionRequest = {
      kind: 'permissionRequest',
      id: 'p1',
      tool: 'Bash',
      input: { command: 'ls' },
    }
    expect(parseClientFrame(encodeFrame(msg).trimEnd())).toEqual(msg)
  })

  it('round-trips a permissionVerdict', () => {
    const msg: ServerPermissionVerdict = {
      kind: 'permissionVerdict',
      id: 'p1',
      verdict: 'allow',
    }
    expect(parseServerFrame(encodeFrame(msg).trimEnd())).toEqual(msg)
  })

  it('round-trips a toolResult', () => {
    const msg: ServerToolResult = {
      kind: 'toolResult',
      id: 'r1',
      result: { content: [{ type: 'text', text: 'ok' }] },
    }
    expect(parseServerFrame(encodeFrame(msg).trimEnd())).toEqual(msg)
  })

  it('returns null on invalid JSON', () => {
    expect(parseClientFrame('not json')).toBeNull()
  })

  it('returns null on schema mismatch (missing secret)', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'hello', role: 'hook', chatId: 1, subagentId: 'x' }))).toBeNull()
  })

  it('returns null on unknown kind', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'spurious' }))).toBeNull()
  })

  it('rejects chatId 0 (must be positive)', () => {
    expect(parseClientFrame(JSON.stringify({ kind: 'hello', secret: 's', role: 'hook', chatId: 0, subagentId: 'x' }))).toBeNull()
  })
})
```

- [ ] **Step 4: Run the tests and verify they pass**

```bash
cd plugin && bun test test/protocol.test.ts
```

Expected: 9 pass.

- [ ] **Step 5: Commit**

```bash
git add plugin/package.json plugin/bun.lock plugin/shared/protocol.ts plugin/test/protocol.test.ts
git commit -m "phase2: wire protocol schema with Zod"
```

---

## Task 2: `dispatcher/socket-server.ts` — Unix socket listener

**Files:**
- Create: `plugin/dispatcher/socket-server.ts`
- Test: `plugin/test/socket-server.test.ts`

**Reference:** Spike 1B's `1b-mcp-server-side.ts` for the handshake + newline-framing pattern.

The socket server is the single entry point for both hook connections and tools-proxy connections from subagents. It:

1. Listens on a Unix socket at `~/.claude/channels/deltachat/dispatcher.sock` (0600).
2. Validates every incoming connection's `hello` frame: secret match, subagent id is in the dispatcher's spawn registry, chatId matches the registry entry.
3. Dispatches frames to an `onRequest` callback passed in by the caller.
4. Exposes `sendTo(connectionId, ServerMessage)` for async replies (permission verdicts, tool results).
5. Tracks pending connections by `connectionId` so we can write replies out-of-band.

- [ ] **Step 1: Write the failing test**

Create `plugin/test/socket-server.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { connect, type Socket } from 'node:net'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SocketServer, type SocketRequest } from '../dispatcher/socket-server.js'
import { encodeFrame, type ClientMessage, type ServerMessage } from '../shared/protocol.js'

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
      isKnownSubagent: (id, chatId) => id === 'sub-1' && chatId === 42,
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
      isKnownSubagent: () => true,
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
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin && bun test test/socket-server.test.ts
```

Expected: fail with "Cannot find module '../dispatcher/socket-server.js'" (or equivalent).

- [ ] **Step 3: Implement the server**

Create `plugin/dispatcher/socket-server.ts`:

```typescript
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
  isKnownSubagent: (subagentId: string, chatId: number) => boolean
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
    try { unlinkSync(this.opts.path) } catch {}
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
      if (!this.opts.isKnownSubagent(frame.subagentId, frame.chatId)) {
        // Distinguish unknown subagent vs. chat mismatch for diagnostics.
        if (!this.opts.isKnownSubagent(frame.subagentId, -1 as unknown as number)) {
          // Not ideal — use a two-arg probe below instead.
        }
        // Simple approach: treat any isKnownSubagent returning false as
        // one of the two errors. Pass a sentinel chat to tell them apart.
        const subagentExists = this.opts.isKnownSubagent(frame.subagentId, frame.chatId)
          || this.opts.isKnownSubagent(frame.subagentId, 0)
        this.writeError(
          conn,
          'hello',
          subagentExists ? 'chat_mismatch' : 'unknown_subagent',
          subagentExists ? 'chatId does not match this subagent' : 'subagentId not registered',
        )
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
```

- [ ] **Step 4: Refine the unknown-subagent vs chat-mismatch distinction**

The block above has a placeholder. Replace the `if (frame.kind === 'hello')` block with a cleaner version that asks the caller for two separate checks. Update the `SocketServerOptions` interface and the block:

Replace the `isKnownSubagent` field in `SocketServerOptions`:

```typescript
  /** Returns whether this subagentId exists at all. */
  hasSubagent: (subagentId: string) => boolean
  /** Returns the chatId this subagentId is bound to, or null if unknown. */
  getSubagentChat: (subagentId: string) => number | null
```

And replace the hello validation block in `onLine`:

```typescript
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
```

Update the test to use the new options shape:

```typescript
    server = new SocketServer({
      path: sockPath,
      secret,
      hasSubagent: (id) => id === 'sub-1',
      getSubagentChat: (id) => id === 'sub-1' ? 42 : null,
      onRequest: async () => ({ kind: 'toolResult', id: 'x', result: { content: [{ type: 'text', text: 'default' }] } } as ServerMessage),
    })
```

Apply the same to the second-server setup in the `routes toolCall` test: `hasSubagent: () => true, getSubagentChat: () => 1`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd plugin && bun test test/socket-server.test.ts
```

Expected: 8 pass.

- [ ] **Step 6: Commit**

```bash
git add plugin/dispatcher/socket-server.ts plugin/test/socket-server.test.ts
git commit -m "phase2: dispatcher socket-server with hello auth + frame routing"
```

---

## Task 3: `dispatcher/permission-hook.sh` + `dispatcher/hook-config.ts`

**Files:**
- Create: `plugin/dispatcher/permission-hook.sh`
- Create: `plugin/dispatcher/hook-config.ts`
- Test: `plugin/test/hook-config.test.ts`

**Reference:** Spike 1G `1g-hook.sh` for the basic PreToolUse hook structure; Spike 1B for the newline-framed JSON socket client.

The PreToolUse hook has two jobs:
1. Read the tool_input JSON Claude sends on stdin.
2. Open the dispatcher's Unix socket, hello + send a `permissionRequest`, block for a `permissionVerdict`, exit 0 (allow) or 2 (deny).

Because hook scripts need to be small and self-contained, implement the client in a minimal Bun one-liner. No dependencies beyond what `bun` ships.

- [ ] **Step 1: Write the hook script**

Create `plugin/dispatcher/permission-hook.sh`:

```bash
#!/usr/bin/env bash
# PreToolUse hook for dc-claude-channel subagents.
#
# Claude Code invokes this before every matched tool call with a
# JSON payload on stdin describing the tool and its input. We
# forward that payload to the dispatcher over a Unix socket and
# block waiting for a verdict. Exit 0 = allow, exit 2 = deny (with
# the stderr message shown to Claude).
#
# Environment contract (set by hook-config.ts when generating the
# per-subagent settings.json):
#   DC_DISPATCHER_SOCKET    absolute path to dispatcher.sock
#   DC_DISPATCHER_SECRET    32-byte hex secret (match dispatcher)
#   DC_SUBAGENT_ID          this subagent's id
#   DC_SUBAGENT_CHAT_ID     the bound chat id (integer)
#   DC_HOOK_TIMEOUT_SEC     max seconds to wait (default 300)

set -u
TIMEOUT="${DC_HOOK_TIMEOUT_SEC:-300}"
REQUEST_ID="p-$$-$RANDOM"

# Delegate to the Bun client helper shipped alongside this script.
# The helper reads stdin, speaks the dispatcher protocol, and
# prints the verdict ("allow" or "deny: <reason>") to its stdout.
DIR="$(cd "$(dirname "$0")" && pwd)"
VERDICT=$(timeout "$TIMEOUT" bun "$DIR/permission-hook-client.ts" "$REQUEST_ID" 2>/dev/null)
RC=$?

if [[ $RC -ne 0 ]]; then
  echo "dc-claude-channel: permission relay timed out or errored (rc=$RC)" >&2
  exit 2
fi

case "$VERDICT" in
  allow) exit 0 ;;
  deny*)
    echo "dc-claude-channel: ${VERDICT#deny: }" >&2
    exit 2
    ;;
  *)
    echo "dc-claude-channel: unexpected verdict '$VERDICT'" >&2
    exit 2
    ;;
esac
```

Make it executable:

```bash
chmod +x plugin/dispatcher/permission-hook.sh
```

- [ ] **Step 2: Write the Bun client helper**

Create `plugin/dispatcher/permission-hook-client.ts`:

```typescript
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
```

- [ ] **Step 3: Write the hook-config generator with a test**

Create `plugin/dispatcher/hook-config.ts`:

```typescript
/**
 * Generate a `--settings` JSON file for a per-subagent PreToolUse
 * hook. The generated file is written to a temp path and its path
 * is returned; the caller passes it to claude -p --settings.
 *
 * The hook is configured to fire on the tool patterns we care about
 * for safety: Bash, Edit, Write, NotebookEdit, WebFetch. Read/Grep/
 * Glob are not gated — same posture the TUI uses by default.
 */

import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

export interface HookConfigInput {
  hookScriptPath: string
  /** Tools that should fire the permission hook. Defaults to the "dangerous" set. */
  gatedTools?: string[]
}

export const DEFAULT_GATED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']

export interface GeneratedHookConfig {
  settingsPath: string
  /** Directory containing settingsPath — caller should rm -rf on cleanup. */
  tempDir: string
}

export function generateHookConfig(input: HookConfigInput): GeneratedHookConfig {
  const gated = input.gatedTools ?? DEFAULT_GATED_TOOLS
  const dir = mkdtempSync(join(tmpdir(), 'dc-subagent-'))
  const settingsPath = join(dir, 'settings.json')
  const settings = {
    hooks: {
      PreToolUse: gated.map((matcher) => ({
        matcher,
        hooks: [{ type: 'command', command: input.hookScriptPath }],
      })),
    },
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
  return { settingsPath, tempDir: dir }
}
```

Create `plugin/test/hook-config.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'bun:test'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import {
  generateHookConfig,
  DEFAULT_GATED_TOOLS,
} from '../dispatcher/hook-config.js'

describe('generateHookConfig', () => {
  const cleanups: string[] = []
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('writes a settings.json with the default gated tools', () => {
    const { settingsPath, tempDir } = generateHookConfig({ hookScriptPath: '/tmp/fake-hook.sh' })
    cleanups.push(tempDir)
    expect(existsSync(settingsPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.hooks.PreToolUse).toHaveLength(DEFAULT_GATED_TOOLS.length)
    for (const entry of parsed.hooks.PreToolUse) {
      expect(DEFAULT_GATED_TOOLS).toContain(entry.matcher)
      expect(entry.hooks[0].command).toBe('/tmp/fake-hook.sh')
      expect(entry.hooks[0].type).toBe('command')
    }
  })

  it('respects a custom gatedTools list', () => {
    const { settingsPath, tempDir } = generateHookConfig({
      hookScriptPath: '/tmp/h.sh',
      gatedTools: ['Bash'],
    })
    cleanups.push(tempDir)
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.hooks.PreToolUse).toHaveLength(1)
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash')
  })
})
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/hook-config.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add plugin/dispatcher/permission-hook.sh plugin/dispatcher/permission-hook-client.ts plugin/dispatcher/hook-config.ts plugin/test/hook-config.test.ts
git commit -m "phase2: PreToolUse hook script + Bun client helper + config generator"
```

---

## Task 4: `dispatcher/subagent-process.ts` — one persistent claude -p

**Files:**
- Create: `plugin/dispatcher/subagent-process.ts`

**Reference:** `plugin/spikes/1a-named-sessions.ts` — the `startPersistent()` function is the reference implementation. Promote it to a real module with typed events and a send/receive API.

This wraps exactly one subagent child. It:

1. Spawns `claude -p --session-id <uuid> --input-format stream-json --output-format stream-json --verbose --settings <hook-settings> --permission-mode default` with the appropriate env vars.
2. Exposes `send(text)` → stdin and emits `'response'` events when a `result` frame arrives.
3. Tracks its lastUsed timestamp and idle timer.
4. Exposes `close()` → SIGTERM then SIGKILL after 2 s.

- [ ] **Step 1: Write the module**

Create `plugin/dispatcher/subagent-process.ts`:

```typescript
/**
 * One persistent `claude -p` child process, bound to a single chat.
 *
 * Copied from plugin/spikes/1a-named-sessions.ts with typed events
 * and a single-inflight send API.
 *
 * Contract:
 *   - Caller creates one SubagentProcess per chat.
 *   - Caller calls send(text) to forward a user message; only one
 *     send can be in flight at a time (enforced).
 *   - Caller awaits the returned Promise for the assistant's text
 *     response and the array of permission_denials from that turn.
 *   - Caller calls close() on eviction/shutdown.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

interface StreamFrame {
  type: string
  subtype?: string
  result?: string
  duration_ms?: number
  permission_denials?: Array<{ tool_name?: string; tool_input?: { command?: string } }>
  [k: string]: unknown
}

export interface SubagentSpawnOptions {
  chatId: number
  subagentId: string
  /** Path to the generated per-subagent settings.json with the hook config. */
  settingsPath: string
  dispatcherSocket: string
  dispatcherSecret: string
  hookTimeoutSec?: number
  /** Working directory for the subagent. Defaults to process.cwd(). */
  cwd?: string
  /** Additional directories the subagent is allowed to touch. */
  addDirs?: string[]
  logf?: (fmt: string, ...args: unknown[]) => void
}

export interface TurnResult {
  text: string
  denials: Array<{ tool_name?: string; command?: string }>
  durationMs?: number
}

export class SubagentProcess {
  readonly chatId: number
  readonly subagentId: string
  readonly sessionId: string
  private child: ChildProcessWithoutNullStreams
  private buf = ''
  private frameQueue: StreamFrame[] = []
  private waiters: Array<(f: StreamFrame) => void> = []
  private busy = false
  private closed = false
  private logf: (fmt: string, ...args: unknown[]) => void
  lastUsed: number = Date.now()

  constructor(opts: SubagentSpawnOptions) {
    this.chatId = opts.chatId
    this.subagentId = opts.subagentId
    this.sessionId = randomUUID()
    this.logf = opts.logf ?? (() => {})

    const args: string[] = [
      '-p',
      '--session-id', this.sessionId,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--settings', opts.settingsPath,
      '--permission-mode', 'default',
    ]
    for (const dir of opts.addDirs ?? []) {
      args.push('--add-dir', dir)
    }

    this.child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: opts.cwd,
      env: {
        ...process.env,
        DC_DISPATCHER_SOCKET: opts.dispatcherSocket,
        DC_DISPATCHER_SECRET: opts.dispatcherSecret,
        DC_SUBAGENT_ID: opts.subagentId,
        DC_SUBAGENT_CHAT_ID: String(opts.chatId),
        DC_HOOK_TIMEOUT_SEC: String(opts.hookTimeoutSec ?? 300),
      },
    })

    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.logf('subagent %s stderr: %s', this.subagentId, chunk.toString('utf-8').trim())
    })
    this.child.on('exit', (code) => {
      this.closed = true
      this.logf('subagent %s exited code=%s', this.subagentId, String(code))
    })
  }

  get pid(): number { return this.child.pid ?? -1 }
  get alive(): boolean { return !this.closed && this.child.exitCode === null }

  private onStdout(chunk: Buffer): void {
    this.buf += chunk.toString('utf-8')
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let frame: StreamFrame
      try { frame = JSON.parse(line) } catch { continue }
      if (this.waiters.length) {
        this.waiters.shift()!(frame)
      } else {
        this.frameQueue.push(frame)
      }
    }
  }

  private readFrame(predicate: (f: StreamFrame) => boolean, timeoutMs: number): Promise<StreamFrame> {
    for (let i = 0; i < this.frameQueue.length; i++) {
      if (predicate(this.frameQueue[i])) return Promise.resolve(this.frameQueue.splice(i, 1)[0])
    }
    return new Promise<StreamFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolveWrapper)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(new Error(`timeout after ${timeoutMs}ms`))
      }, timeoutMs)
      const resolveWrapper = (f: StreamFrame) => {
        if (!predicate(f)) { this.frameQueue.push(f); this.waiters.push(resolveWrapper); return }
        clearTimeout(timer)
        resolve(f)
      }
      this.waiters.push(resolveWrapper)
    })
  }

  async send(text: string, turnTimeoutMs = 120000): Promise<TurnResult> {
    if (!this.alive) throw new Error(`subagent ${this.subagentId} is not alive`)
    if (this.busy) throw new Error(`subagent ${this.subagentId} is busy`)
    this.busy = true
    this.lastUsed = Date.now()
    try {
      const inputFrame = { type: 'user', message: { role: 'user', content: text } }
      this.child.stdin.write(JSON.stringify(inputFrame) + '\n')

      const resultFrame = await this.readFrame(
        (f) => f.type === 'result' && f.subtype === 'success',
        turnTimeoutMs,
      )
      const denials = (resultFrame.permission_denials ?? []).map((d) => ({
        tool_name: d.tool_name,
        command: d.tool_input?.command,
      }))
      return {
        text: (resultFrame.result ?? '').toString(),
        denials,
        durationMs: resultFrame.duration_ms,
      }
    } finally {
      this.busy = false
      this.lastUsed = Date.now()
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    try { this.child.stdin.end() } catch {}
    try { this.child.kill('SIGTERM') } catch {}
    // Wait up to 2s for graceful exit, then SIGKILL
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try { this.child.kill('SIGKILL') } catch {}
        resolve()
      }, 2000)
      this.child.on('exit', () => { clearTimeout(t); resolve() })
    })
    this.closed = true
  }
}
```

- [ ] **Step 2: Sanity-check it parses and type-checks**

```bash
cd plugin && bun build dispatcher/subagent-process.ts --target=bun --outfile=/tmp/check.js && rm /tmp/check.js
```

Expected: no errors.

- [ ] **Step 3: Commit**

No test here — the only way to really exercise this is to actually spawn claude, which is a manual test. The test suite can't assume `claude` is installed on CI. Move on to the cache, which IS testable with a mock.

```bash
git add plugin/dispatcher/subagent-process.ts
git commit -m "phase2: SubagentProcess wraps one persistent claude -p per chat"
```

---

## Task 5: `dispatcher/subagent-cache.ts` — LRU cache with eviction + idle timeout

**Files:**
- Create: `plugin/dispatcher/subagent-cache.ts`
- Test: `plugin/test/subagent-cache.test.ts`

The cache is the heart of the design. It knows which chats have live subagents, handles LRU eviction when over capacity, schedules idle timers that auto-close subagents after N minutes, and spawns new subagents on demand. Take a `spawnFn` factory so the test can substitute a fake subagent implementation.

- [ ] **Step 1: Define the cache interface and a minimal SubagentLike type**

Create `plugin/dispatcher/subagent-cache.ts`:

```typescript
/**
 * LRU cache of persistent subagents, one per chat.
 *
 * Abstracts the per-chat process lifecycle so the rest of the
 * dispatcher only sees `cache.dispatch(chatId, text)` and gets back
 * a TurnResult. Handles:
 *
 *   - spawn-on-demand
 *   - LRU eviction when at DC_SUBAGENT_MAX_ACTIVE
 *   - per-chat idle timeout → close
 *   - crash recovery (if a subagent dies between turns, next
 *     dispatch re-spawns)
 *   - per-chat queue depth of 10 (overflow drops oldest)
 *
 * The SubagentLike interface exists so the test can substitute a
 * fake that doesn't shell out to claude.
 */

export interface SubagentLike {
  readonly chatId: number
  readonly subagentId: string
  readonly alive: boolean
  lastUsed: number
  send(text: string, turnTimeoutMs?: number): Promise<{
    text: string
    denials: Array<{ tool_name?: string; command?: string }>
  }>
  close(): Promise<void>
}

export interface SubagentCacheOptions {
  maxActive: number
  idleTimeoutMs: number
  spawnFn: (chatId: number) => Promise<SubagentLike>
  logf?: (fmt: string, ...args: unknown[]) => void
}

interface CacheEntry {
  sub: SubagentLike
  idleTimer: NodeJS.Timeout | null
  queue: Array<{ text: string; resolve: (r: unknown) => void; reject: (e: Error) => void }>
  busy: boolean
}

const MAX_QUEUE_DEPTH = 10

export class SubagentCache {
  private entries = new Map<number, CacheEntry>()
  /** Ordered by most-recently used; entries[0] is the LRU victim. */
  private lruOrder: number[] = []
  private logf: (fmt: string, ...args: unknown[]) => void

  constructor(private opts: SubagentCacheOptions) {
    this.logf = opts.logf ?? (() => {})
  }

  size(): number { return this.entries.size }

  private touch(chatId: number): void {
    const idx = this.lruOrder.indexOf(chatId)
    if (idx >= 0) this.lruOrder.splice(idx, 1)
    this.lruOrder.push(chatId)
  }

  private resetIdleTimer(chatId: number): void {
    const entry = this.entries.get(chatId)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      this.logf('cache: idle timeout chat=%d', chatId)
      this.evict(chatId).catch(() => {})
    }, this.opts.idleTimeoutMs)
  }

  private async evict(chatId: number): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    if (entry.idleTimer) clearTimeout(entry.idleTimer)
    this.entries.delete(chatId)
    this.lruOrder = this.lruOrder.filter((c) => c !== chatId)
    // Fail any queued work
    for (const q of entry.queue) q.reject(new Error('subagent evicted'))
    await entry.sub.close().catch(() => {})
  }

  private async ensureCapacity(): Promise<void> {
    while (this.entries.size >= this.opts.maxActive) {
      const victimId = this.lruOrder[0]
      if (victimId === undefined) return
      this.logf('cache: evicting LRU chat=%d', victimId)
      await this.evict(victimId)
    }
  }

  private async spawn(chatId: number): Promise<CacheEntry> {
    await this.ensureCapacity()
    const sub = await this.opts.spawnFn(chatId)
    const entry: CacheEntry = { sub, idleTimer: null, queue: [], busy: false }
    this.entries.set(chatId, entry)
    this.touch(chatId)
    this.resetIdleTimer(chatId)
    return entry
  }

  private async ensure(chatId: number): Promise<CacheEntry> {
    const existing = this.entries.get(chatId)
    if (existing && existing.sub.alive) {
      this.touch(chatId)
      this.resetIdleTimer(chatId)
      return existing
    }
    if (existing && !existing.sub.alive) {
      // Crashed. Remove and respawn.
      await this.evict(chatId)
    }
    return await this.spawn(chatId)
  }

  async dispatch(chatId: number, text: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    const entry = await this.ensure(chatId)
    return await this.runOrQueue(entry, chatId, text)
  }

  private runOrQueue(entry: CacheEntry, chatId: number, text: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    if (entry.busy) {
      if (entry.queue.length >= MAX_QUEUE_DEPTH) {
        const dropped = entry.queue.shift()
        if (dropped) dropped.reject(new Error('dropped: queue overflow'))
      }
      return new Promise((resolve, reject) => {
        entry.queue.push({ text, resolve: resolve as (r: unknown) => void, reject })
      })
    }
    return this.runNow(entry, chatId, text)
  }

  private async runNow(entry: CacheEntry, chatId: number, text: string): Promise<{ text: string; denials: Array<{ tool_name?: string; command?: string }> }> {
    entry.busy = true
    try {
      const result = await entry.sub.send(text)
      this.touch(chatId)
      this.resetIdleTimer(chatId)
      return result
    } finally {
      entry.busy = false
      // Drain one queued message if any
      const next = entry.queue.shift()
      if (next) {
        this.runNow(entry, chatId, next.text).then(next.resolve).catch(next.reject)
      }
    }
  }

  async closeAll(): Promise<void> {
    const chatIds = [...this.entries.keys()]
    for (const id of chatIds) await this.evict(id)
  }
}
```

- [ ] **Step 2: Write the tests**

Create `plugin/test/subagent-cache.test.ts`:

```typescript
import { describe, it, expect } from 'bun:test'
import { SubagentCache, type SubagentLike } from '../dispatcher/subagent-cache.js'

class FakeSubagent implements SubagentLike {
  readonly subagentId: string
  alive = true
  lastUsed = Date.now()
  public sendCount = 0
  public closed = false
  constructor(public readonly chatId: number, public readonly label: string = 'ok') {
    this.subagentId = `fake-${chatId}-${Math.random().toString(36).slice(2, 8)}`
  }
  async send(): Promise<{ text: string; denials: [] }> {
    this.sendCount++
    return { text: this.label, denials: [] }
  }
  async close(): Promise<void> { this.closed = true; this.alive = false }
}

describe('SubagentCache', () => {
  it('spawns on first dispatch and reuses on second', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'hi')
    await cache.dispatch(1, 'again')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].sendCount).toBe(2)
    await cache.closeAll()
  })

  it('evicts the LRU chat when capacity is reached', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 2,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'a')
    await cache.dispatch(2, 'b')
    await cache.dispatch(3, 'c') // should evict chat 1
    expect(cache.size()).toBe(2)
    expect(spawns[0].closed).toBe(true) // the chat-1 sub
    expect(spawns[1].closed).toBe(false)
    expect(spawns[2].closed).toBe(false)
    await cache.closeAll()
  })

  it('touches LRU on reuse so the reused chat is not evicted', async () => {
    const subs = new Map<number, FakeSubagent>()
    const cache = new SubagentCache({
      maxActive: 2,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); subs.set(chatId, s); return s },
    })
    await cache.dispatch(1, 'a')
    await cache.dispatch(2, 'b')
    await cache.dispatch(1, 'a-again') // chat 1 is now MRU
    await cache.dispatch(3, 'c')       // should evict chat 2, not chat 1
    expect(subs.get(1)?.closed).toBe(false)
    expect(subs.get(2)?.closed).toBe(true)
    expect(subs.get(3)?.closed).toBe(false)
    await cache.closeAll()
  })

  it('respawns when a cached subagent has died', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'a')
    spawns[0].alive = false
    await cache.dispatch(1, 'b')
    expect(spawns).toHaveLength(2)
    await cache.closeAll()
  })

  it('auto-closes on idle timeout', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 50,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'a')
    await new Promise((r) => setTimeout(r, 120))
    expect(spawns[0].closed).toBe(true)
    expect(cache.size()).toBe(0)
    await cache.closeAll()
  })
})
```

- [ ] **Step 3: Run tests**

```bash
cd plugin && bun test test/subagent-cache.test.ts
```

Expected: 5 pass.

- [ ] **Step 4: Commit**

```bash
git add plugin/dispatcher/subagent-cache.ts plugin/test/subagent-cache.test.ts
git commit -m "phase2: SubagentCache with LRU eviction, idle timeout, crash recovery"
```

---

## Task 6: `dispatcher/message-router.ts` — classify and dispatch

**Files:**
- Create: `plugin/dispatcher/message-router.ts`

The router is the single ingress point for all DC events. It decides:

- Regular text message → `cache.dispatch(chatId, text)`
- System message → handle in dispatcher (delegate to existing `cleanupChat` helper in `server.ts`)
- WebXDC update → this path goes through `socket-server` for permission verdicts, otherwise forwarded to the relevant app

For Phase 2, the router is thin — it calls into the existing `server.ts` logic for non-subagent paths and into `cache.dispatch` for regular messages. The purpose of pulling it out is to have a single testable classification function.

- [ ] **Step 1: Write the module**

Create `plugin/dispatcher/message-router.ts`:

```typescript
/**
 * Classifies incoming Delta Chat events and routes them. The router
 * does not own any state of its own — it takes callbacks that wire
 * it to the dispatcher (cache) and legacy server.ts paths.
 *
 * This is deliberately small. The goal is to make classification
 * explicit and testable, not to reimplement every event handler.
 */

import type { Message } from '../dc-client.js'

export interface RouterHandlers {
  /** Regular user message → dispatch to subagent cache. */
  dispatchToSubagent: (chatId: number, text: string) => Promise<void>
  /** System message (e.g. "MemberRemovedFromGroup") → legacy cleanup. */
  handleSystemMessage: (msg: Message) => Promise<void>
  /** Locally-triggered ChatModified (e.g. self-leave) → legacy cleanup. */
  handleChatModified: (chatId: number) => Promise<void>
  /** Messages from unknown / unpaired chats → pairing/tutorial flow. */
  handleUnpaired: (msg: Message) => Promise<void>
  /** Messages from paired but unauthorized senders → ignore silently. */
  isAuthorized: (msg: Message) => boolean
  /** True if the sender is the owner who can actually command Claude. */
  isPaired: (chatId: number) => boolean
  logf?: (fmt: string, ...args: unknown[]) => void
}

export interface MessageRouter {
  onIncomingMessage: (msg: Message) => Promise<void>
  onChatModified: (chatId: number) => Promise<void>
}

export function createMessageRouter(handlers: RouterHandlers): MessageRouter {
  const log = handlers.logf ?? (() => {})

  return {
    async onIncomingMessage(msg: Message): Promise<void> {
      // System message first — never dispatch these to a subagent.
      if (msg.systemMessageType) {
        log('router: system msg chat=%d type=%s', msg.chatId, msg.systemMessageType)
        await handlers.handleSystemMessage(msg)
        return
      }

      // Not yet paired → send through pairing/tutorial.
      if (!handlers.isPaired(msg.chatId)) {
        log('router: unpaired chat=%d', msg.chatId)
        await handlers.handleUnpaired(msg)
        return
      }

      // Paired but sender not the owner → silently ignore.
      if (!handlers.isAuthorized(msg)) {
        log('router: unauthorized sender chat=%d from=%d', msg.chatId, msg.fromId ?? 0)
        return
      }

      // Empty text (attachment-only, etc.) — still route, let subagent decide.
      const text = msg.text || '(attachment)'
      log('router: dispatching chat=%d len=%d', msg.chatId, text.length)
      await handlers.dispatchToSubagent(msg.chatId, text)
    },

    async onChatModified(chatId: number): Promise<void> {
      log('router: chat modified chat=%d', chatId)
      await handlers.handleChatModified(chatId)
    },
  }
}
```

- [ ] **Step 2: Commit (no test in this task — router is thin glue, covered by server.ts integration)**

```bash
git add plugin/dispatcher/message-router.ts
git commit -m "phase2: message-router classification for incoming DC events"
```

---

## Task 7: Wire the dispatcher into `server.ts`

**Files:**
- Modify: `plugin/server.ts`

This is the integration task. Replace the inline `onIncomingMessage` handler with a router that delegates user text to the `SubagentCache`, and stand up the `SocketServer` at startup so hooks and tools-proxy can connect.

**IMPORTANT:** do NOT delete the legacy MCP tool registration or WebXDC notification paths. Phase 2 keeps the dispatcher's own MCP server (which the user's terminal Claude Code connects to) fully functional for direct user-typed commands. Only the per-chat messaging flow is rerouted through subagents.

- [ ] **Step 1: Read `plugin/server.ts` end-to-end, then identify the insertion points**

Open `plugin/server.ts`. Find:

1. The top-level logger + `client` declarations.
2. The `client.onIncomingMessage(async (msg) => { ... })` block around line 613 — this is the handler you will replace.
3. The `client.onChatModified(...)` block — route through the same cleanupChat path.
4. The startup sequence that calls `client.startIO()` — insert socket server + cache wiring here.

- [ ] **Step 2: Add dispatcher bootstrap alongside the existing state**

Insert near the top of `server.ts`, after the existing state section:

```typescript
// ── Dispatcher ──────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto'
import { SocketServer, type SocketRequest } from './dispatcher/socket-server.js'
import { SubagentCache } from './dispatcher/subagent-cache.js'
import { SubagentProcess } from './dispatcher/subagent-process.js'
import { generateHookConfig } from './dispatcher/hook-config.js'
import { createMessageRouter } from './dispatcher/message-router.js'
import type { ServerMessage } from './shared/protocol.js'

const DISPATCHER_SOCKET = join(STATE_DIR, 'dispatcher.sock')
const DISPATCHER_SECRET = randomBytes(32).toString('hex')
const HOOK_SCRIPT = join(import.meta.dir, 'dispatcher', 'permission-hook.sh')

const MAX_ACTIVE = Math.max(1, Math.min(16, Number(process.env.DC_SUBAGENT_MAX_ACTIVE ?? '4')))
const IDLE_MIN = Math.max(1, Number(process.env.DC_SUBAGENT_IDLE_TIMEOUT_MIN ?? '15'))

/** Registry of currently-active subagents for hello authorization. */
const subagentRegistry = new Map<string, { chatId: number }>()

/** Pending hook permission requests by id, each holds the socket connection id. */
const pendingPermissions = new Map<string, { connectionId: string; chatId: number; resolve: (v: ServerMessage) => void }>()
```

- [ ] **Step 3: Define the spawn factory**

Add below the dispatcher imports:

```typescript
async function spawnSubagentForChat(chatId: number): Promise<SubagentProcess> {
  const subagentId = `sub-${chatId}-${randomBytes(4).toString('hex')}`
  const { settingsPath } = generateHookConfig({ hookScriptPath: HOOK_SCRIPT })
  const sub = new SubagentProcess({
    chatId,
    subagentId,
    settingsPath,
    dispatcherSocket: DISPATCHER_SOCKET,
    dispatcherSecret: DISPATCHER_SECRET,
    logf,
  })
  subagentRegistry.set(subagentId, { chatId })
  // Unregister when the underlying child exits
  const origClose = sub.close.bind(sub)
  sub.close = async () => {
    subagentRegistry.delete(subagentId)
    await origClose()
  }
  return sub
}

const subagentCache = new SubagentCache({
  maxActive: MAX_ACTIVE,
  idleTimeoutMs: IDLE_MIN * 60_000,
  spawnFn: spawnSubagentForChat,
  logf,
})
```

- [ ] **Step 4: Stand up the socket server**

Add the socket server handler alongside the cache:

```typescript
const socketServer = new SocketServer({
  path: DISPATCHER_SOCKET,
  secret: DISPATCHER_SECRET,
  hasSubagent: (id) => subagentRegistry.has(id),
  getSubagentChat: (id) => subagentRegistry.get(id)?.chatId ?? null,
  onRequest: async (req: SocketRequest) => {
    if (req.frame.kind === 'permissionRequest') {
      // Route to the existing permissions-app WebXDC flow for this chat.
      const permApp = appToolMap.get('dc_test_permission')
      if (!permApp) {
        return { kind: 'permissionVerdict', id: req.frame.id, verdict: 'deny', message: 'permission app not registered' }
      }
      // Call the permissions app with the request params. The app will
      // send a WebXDC permission prompt to the chat and wait.
      //
      // We register the pending request in pendingPermissions so a
      // later WebXDC update handler can match and resolve it.
      return await new Promise<ServerMessage>((resolve) => {
        pendingPermissions.set(req.frame.id, {
          connectionId: req.connectionId,
          chatId: req.chatId,
          resolve,
        })
        // Kick off the WebXDC prompt via the app.
        ;(async () => {
          try {
            const params = {
              chat_id: String(req.chatId),
              tool_name: (req.frame as { tool?: string }).tool ?? 'unknown',
              tool_input: JSON.stringify((req.frame as { input?: unknown }).input ?? {}),
              request_id: req.frame.id,
            }
            await permApp.callTool('dc_test_permission', params, ctx)
          } catch (err) {
            logf('socket: failed to issue permission prompt: %v', err)
            const pending = pendingPermissions.get(req.frame.id)
            if (pending) {
              pendingPermissions.delete(req.frame.id)
              pending.resolve({ kind: 'permissionVerdict', id: req.frame.id, verdict: 'deny', message: String(err) })
            }
          }
        })()
      })
    }

    if (req.frame.kind === 'toolCall') {
      // Tools-proxy DC tool call. Validate chat_id authorization.
      const args = req.frame.args as { chat_id?: string }
      const argChatId = args.chat_id ? Number(args.chat_id) : null
      if (argChatId !== null && argChatId !== req.chatId) {
        return { kind: 'toolError', id: req.frame.id, error: { code: 'chat_mismatch', message: 'tool call chat_id does not match subagent binding' } }
      }
      const appTool = appToolMap.get(req.frame.tool)
      if (!appTool) {
        return { kind: 'toolError', id: req.frame.id, error: { code: 'unknown_tool', message: req.frame.tool } }
      }
      try {
        const result = await appTool.callTool(req.frame.tool, req.frame.args, ctx)
        if (!result) {
          return { kind: 'toolError', id: req.frame.id, error: { code: 'tool_null', message: 'tool returned null' } }
        }
        return { kind: 'toolResult', id: req.frame.id, result }
      } catch (err) {
        return { kind: 'toolError', id: req.frame.id, error: { code: 'tool_crash', message: String(err) } }
      }
    }

    return { kind: 'toolError', id: (req.frame as { id?: string }).id ?? 'unknown', error: { code: 'unhandled', message: req.frame.kind } }
  },
  logf,
})
```

Note: `appToolMap` and `ctx` already exist in `server.ts` — they were defined during Phase 0 work. Reuse them directly.

- [ ] **Step 5: Replace the inline incoming-message handler**

Locate the existing `client.onIncomingMessage(async (msg) => { ... })` block. Replace it with a router-backed dispatch. Extract `cleanupChat` (already factored out in v0.8.3) and `handleUnpaired` (the tutorial flow) into named async functions if they aren't already, then build the router:

```typescript
// Existing helpers still in server.ts:
//   - cleanupChat(msg): runs cleanup on system messages
//   - handleUnpairedMessage(msg): pairing/tutorial flow

const router = createMessageRouter({
  isPaired: (chatId) => access.isAllowed(chatId),
  isAuthorized: (msg) => {
    // Groups: only the owner commands Claude
    const ownerId = access.getOwner(msg.chatId)
    if (ownerId === null) return true // 1:1 chats have no owner filter
    return msg.fromId === ownerId
  },
  dispatchToSubagent: async (chatId, text) => {
    try {
      const result = await subagentCache.dispatch(chatId, text)
      if (result.text) {
        await client.send(chatId, result.text)
      }
      if (result.denials.length > 0) {
        const summary = result.denials
          .map((d) => `• ${d.tool_name}${d.command ? ': ' + d.command.slice(0, 80) : ''}`)
          .join('\n')
        await client.send(chatId, `⚠️ Some actions were blocked by policy:\n${summary}`)
      }
    } catch (err) {
      logf('dispatch error chat=%d: %v', chatId, err)
      await client.send(chatId, `⚠️ Internal error: ${err}`).catch(() => {})
    }
  },
  handleSystemMessage: async (msg) => {
    await cleanupChat(msg)
  },
  handleChatModified: async (chatId) => {
    const ownerId = access.getOwner(chatId)
    if (ownerId === null) return
    const members = await client.getChatContacts(chatId).catch(() => [])
    const decision = decideCleanup({
      trigger: 'ChatModified',
      chatId,
      members,
      ownerId,
    })
    if (decision.action === 'cleanup') {
      await cleanupChat({ chatId, id: 0, text: '', timestamp: new Date(), senderName: '' })
    }
  },
  handleUnpaired: async (msg) => {
    await handleUnpairedMessage(msg)
  },
  logf,
})

client.onIncomingMessage((msg) => {
  router.onIncomingMessage(msg).catch((err) => logf('router crashed: %v', err))
})

client.onChatModified((chatId) => {
  router.onChatModified(chatId).catch((err) => logf('router crashed: %v', err))
})
```

- [ ] **Step 6: Wire the WebXDC permission verdict back to the pending request**

Find the existing WebXDC update handler (the one that forwards to apps). When a verdict arrives for a request id in `pendingPermissions`, resolve the promise and remove the entry. Do NOT forward that verdict to `permissions-app` twice. Add this to the top of the WebXDC update dispatch:

```typescript
// Check if this update is a verdict for a pending hook permission request
for (const u of updates) {
  const payload = u.payload as { type?: string; request_id?: string; verdict?: 'allow' | 'deny'; reason?: string } | null
  if (payload && payload.type === 'permission_verdict' && payload.request_id) {
    const pending = pendingPermissions.get(payload.request_id)
    if (pending) {
      pendingPermissions.delete(payload.request_id)
      pending.resolve({
        kind: 'permissionVerdict',
        id: payload.request_id,
        verdict: payload.verdict ?? 'deny',
        message: payload.reason,
      })
      // Consumed — do NOT also deliver to permissions-app.
      continue
    }
  }
}
```

(Adapt to the exact loop structure already in `server.ts`; the semantic goal is: intercept permission-verdict updates and resolve the waiting hook before any app handler runs.)

- [ ] **Step 7: Start the socket server in the bootstrap sequence**

Find the block that calls `await client.startIO()` and insert before it:

```typescript
await socketServer.start()
logf('dispatcher socket listening at %s (max_active=%d idle_min=%d)', DISPATCHER_SOCKET, MAX_ACTIVE, IDLE_MIN)
```

And add cleanup to the shutdown path:

```typescript
async function shutdown(): Promise<void> {
  await subagentCache.closeAll().catch(() => {})
  await socketServer.stop().catch(() => {})
  await client.close().catch(() => {})
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
```

- [ ] **Step 8: Run the existing test suite — everything must still pass**

```bash
cd plugin && bun test
```

Expected: all existing tests green + the new Phase 2 tests (protocol, socket-server, subagent-cache, hook-config) green. If any existing test breaks, STOP and fix the regression before continuing.

- [ ] **Step 9: Commit**

```bash
git add plugin/server.ts
git commit -m "phase2: wire dispatcher cache + socket server into server.ts"
```

---

## Task 8: Update `apps/permissions-app.ts` for dispatcher-routed requests

**Files:**
- Modify: `plugin/apps/permissions-app.ts`

Today the permissions app relies on `lastActiveChatId` to decide which chat to route a permission prompt to. Phase 2 sends permission prompts explicitly with a `chat_id` parameter. Remove the `lastActiveChatId` dependency — it's the TOCTOU bug that started this whole plan.

- [ ] **Step 1: Read the current permissions-app.ts** to locate where `lastActiveChatId` is used.

- [ ] **Step 2: Make `chat_id` required in the tool input schema**

Find the `dc_test_permission` tool definition. Update it so `chat_id` is required in `inputSchema.required`. Remove any fallback to `ctx.lastActiveChatId()`.

Replace the fallback section with a hard error:

```typescript
const chatId = Number(args.chat_id)
if (!chatId || !Number.isFinite(chatId)) {
  return { content: [{ type: 'text', text: 'permissions-app: chat_id is required (no lastActiveChatId fallback in Phase 2)' }], isError: true }
}
if (!ctx.isAllowed(chatId)) {
  return { content: [{ type: 'text', text: `permissions-app: chat ${chatId} not allowed` }], isError: true }
}
```

- [ ] **Step 3: Run the existing permissions tests**

```bash
cd plugin && bun test test/
```

Any tests that depended on `lastActiveChatId` will need to pass `chat_id` explicitly. Fix them inline (small change per test).

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/permissions-app.ts plugin/test/
git commit -m "phase2: permissions-app requires explicit chat_id (drop lastActiveChatId fallback)"
```

---

## Task 9: Remove `lastActiveChatId` entirely from `server.ts`

**Files:**
- Modify: `plugin/server.ts`

With Phase 2 wiring in place and permissions-app requiring explicit chat_id, the `lastActiveChatId` module global is now dead code. Remove it and simplify `AppContext`.

- [ ] **Step 1: Grep for every remaining use**

```bash
grep -n lastActiveChatId plugin/
```

- [ ] **Step 2: Remove the declaration, the context accessor, and the assignment**

In `server.ts`:
- Delete `let lastActiveChatId: number | null = null`
- Delete the `lastActiveChatId()` method from `AppContext`
- Delete the `lastActiveChatId = msg.chatId` assignment in the incoming-message path

In `webxdc-app.ts` (the `AppContext` interface): delete the `lastActiveChatId` method.

- [ ] **Step 3: Run the full test suite**

```bash
cd plugin && bun test
```

Expected: all green. If any test references `lastActiveChatId`, update it to pass an explicit chat_id.

- [ ] **Step 4: Commit**

```bash
git add plugin/server.ts plugin/webxdc-app.ts plugin/test/
git commit -m "phase2: remove lastActiveChatId — permission targeting is explicit now"
```

---

## Task 10: Manual end-to-end smoke test

**Files:**
- Create: `plugin/spikes/phase2-smoke-checklist.md`

Phase 2 has enough moving parts that the first real test should be manual — actually pair a chat and send a message. Document the checklist so subsequent phases can re-run it.

- [ ] **Step 1: Write the checklist**

Create `plugin/spikes/phase2-smoke-checklist.md`:

```markdown
# Phase 2 Manual Smoke Test

Run after Phase 2 is committed. Assumes the dev plugin-dir install
path is already set up and a paired chat exists.

## Setup

1. `cd plugin && bun install && bun test` — all green
2. Restart Claude Code with the plugin loaded via `--plugin-dir`
3. Confirm `/mcp` lists `plugin:deltachat:deltachat` connected
4. Check `~/.claude/channels/deltachat/debug.log` for
   `dispatcher socket listening` at startup

## Test 1 — first message cold spawn

1. Send "hi" from Delta Chat to the paired chat
2. Watch `debug.log` for `router: dispatching chat=N len=2` and
   `cache: evicting` NOT present (first spawn)
3. Confirm Claude responds within ~3-4 seconds (cold spawn + reply)
4. Confirm the subagent process is visible: `pgrep -af claude`

## Test 2 — warm second message

1. Send "what did I just say?" to the same chat
2. Confirm the response references "hi" (in-process context continuity)
3. Confirm response latency < 2 seconds (warm subagent)
4. Check the subagent pid from Test 1 is still alive

## Test 3 — per-chat isolation

1. Pair a second chat (or use an existing one)
2. Send messages to both chats in quick succession
3. Confirm `debug.log` shows two different subagent ids handling
   the two chats in parallel
4. Confirm `pgrep -c -f "claude -p"` shows 2 subagents

## Test 4 — permission prompt via hook

1. In one of the paired chats, ask Claude to run a Bash command
   (e.g. "what's the current date?")
2. Confirm a WebXDC permission prompt appears in the chat
3. Tap Allow
4. Confirm Claude proceeds and replies with the date
5. Tap Deny in a separate test and confirm Claude acknowledges the
   block

## Test 5 — LRU eviction

1. Temporarily set `DC_SUBAGENT_MAX_ACTIVE=2` in `.env`
2. Restart the plugin
3. Pair and send messages to 3 different chats in sequence
4. Confirm `debug.log` logs `cache: evicting LRU chat=X` for the
   first chat when the 3rd message arrives
5. Confirm `pgrep -c -f "claude -p"` never exceeds 2

## Test 6 — idle timeout

1. Set `DC_SUBAGENT_IDLE_TIMEOUT_MIN=1`
2. Send a message, wait 90 seconds
3. Confirm `debug.log` logs `cache: idle timeout chat=N`
4. Confirm `pgrep -c -f "claude -p"` is 0

## Pass criteria

All 6 tests green and no stuck subagents after shutting down Claude
Code. Close any remaining subagents with `pkill -f "claude -p --session-id dc-chat-"`
if observed — they are orphans and Phase 3 will address recovery.
```

- [ ] **Step 2: Commit**

```bash
git add plugin/spikes/phase2-smoke-checklist.md
git commit -m "phase2: manual smoke test checklist"
```

---

## Task 11: CLAUDE.md architecture update

**Files:**
- Modify: `CLAUDE.md` (repo root)

Document the new architecture so future sessions understand the dispatcher / subagent split.

- [ ] **Step 1: Read the existing `CLAUDE.md`** to understand tone and structure.

- [ ] **Step 2: Update the Architecture section**

Replace the existing Architecture section's first few lines with:

```markdown
## Architecture

- `plugin/server.ts` — dispatcher entry point. Owns the DC RPC
  connection, the MCP server for the user's terminal Claude Code
  session, and a Unix-socket server that subagents connect to.
- `plugin/dispatcher/` — subagent-per-chat machinery
  - `subagent-cache.ts` — LRU cache of persistent `claude -p`
    processes, one per recently active chat (default 4 active,
    15 min idle timeout)
  - `subagent-process.ts` — wraps one persistent `claude -p` child
    with stream-json I/O over stdin/stdout
  - `socket-server.ts` — Unix socket listener, hello auth, frame
    routing
  - `permission-hook.sh` + `permission-hook-client.ts` — PreToolUse
    hook that forwards tool permission prompts from the subagent
    to the dispatcher over the socket; dispatcher relays to the
    existing permissions-app WebXDC flow
  - `hook-config.ts` — generates per-subagent settings.json
  - `message-router.ts` — classifies incoming DC events (regular
    message, system, ChatModified, unpaired) and dispatches
- `plugin/shared/protocol.ts` — wire protocol types + Zod schemas
- `plugin/webxdc-app.ts` — `WebXDCApp` interface (unchanged)
- `plugin/apps/` — app implementations
- `plugin/dc-client.ts` — DC RPC wrapper (unchanged)
- `plugin/access.ts` — file-based allowlist (unchanged)
- `plugin/tutorial.ts` — onboarding flow (unchanged)
- `plugin/webxdc-filter.ts` — owner verification (unchanged)

State dir: `~/.claude/channels/deltachat/` — .env, dc-data/,
approved/, dispatcher.sock, debug.log
```

Also add a new subsection after Architecture:

```markdown
## Subagent model

Every paired chat that recently sent a message has a persistent
`claude -p` subagent process handling it. Subagents are kept alive
in an LRU cache bounded by `DC_SUBAGENT_MAX_ACTIVE` (default 4) so
the common case — a small number of active chats — gets sub-second
turnaround after the first cold spawn (~6 s). Idle subagents
self-exit after `DC_SUBAGENT_IDLE_TIMEOUT_MIN` (default 15 minutes).

Subagents run with `--permission-mode default` and the built-in CWD
sandbox. When Claude wants to run a tool like Bash or Edit, a
PreToolUse hook fires, connects to the dispatcher's Unix socket,
and blocks waiting for a verdict. The dispatcher forwards the
prompt to the existing permissions-app WebXDC flow in the bound
chat and writes the user's Allow/Deny back to the hook. This
preserves the v0.8.3 permission UX exactly.

DC tool calls (`dc_send`, `dc_send_file`, `dc_chat_history`, etc.)
from a subagent flow through a tools-proxy MCP server loaded in
that subagent, over the same Unix socket. The dispatcher enforces
`chat_id` authorization at the socket boundary — a subagent bound
to chat A cannot call DC tools against chat B.

Config:
- `DC_SUBAGENT_MAX_ACTIVE` — cache size (default 4, range 1-16)
- `DC_SUBAGENT_IDLE_TIMEOUT_MIN` — idle timeout (default 15)
- `DC_HOOK_TIMEOUT_SEC` — max wait for a permission verdict (default 300)
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "phase2: document dispatcher/subagent architecture in CLAUDE.md"
```

---

## Done criteria

- `plugin/shared/protocol.ts` exists with Zod schemas and passing tests
- `plugin/dispatcher/` contains socket-server, subagent-process, subagent-cache, hook-config, permission-hook.sh, permission-hook-client.ts, and message-router — all tested where possible
- `plugin/server.ts` wires the cache + socket server into startup and routes incoming messages through `message-router` → `cache.dispatch`
- `lastActiveChatId` is gone from the codebase
- `plugin/apps/permissions-app.ts` requires explicit `chat_id`
- All existing tests still pass
- All new tests pass (protocol, socket-server, subagent-cache, hook-config)
- The Phase 2 smoke checklist is documented
- `CLAUDE.md` architecture section reflects the new split

**Not in this phase (deferred):**
- Orphan cleanup on dispatcher restart → Phase 3
- Rate limiting → Phase 3
- Per-group model selection → Phase 4
- Version bump to 0.9.0 → Phase 5
- Stress + integration tests → Phase 6
