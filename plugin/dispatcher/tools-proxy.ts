#!/usr/bin/env bun
/**
 * Per-subagent tools-proxy MCP server.
 *
 * Spawned by `claude -p` via the per-subagent mcp-config.json. Loads
 * the tool manifest written by the dispatcher (path in DC_TOOLS_MANIFEST),
 * exposes those tools to the subagent under the `dc` MCP server name,
 * and forwards every CallTool request to the dispatcher over the Unix
 * socket using the shared protocol.
 *
 * Tool calls are gated by the owner's paired-chats allowlist. Chat-scoping
 * is a context-hygiene default, not a privacy boundary — a subagent CAN
 * reach any paired chat via dc_chat_history / dc_send_* / dc_react when it
 * needs to pull or push context across chats. The one exception is the
 * scheduler (dc_schedule*), which requires caller chat_id = target chat_id
 * because a job is owned by its chat.
 *
 * Required env (inherited from the parent claude -p, which inherits
 * from the dispatcher's spawn env):
 *   DC_TOOLS_MANIFEST    path to JSON array of {name, description, inputSchema}
 *   DC_DISPATCHER_SOCKET path to dispatcher.sock
 *   DC_DISPATCHER_SECRET hello secret
 *   DC_SUBAGENT_ID       subagent id (used in hello)
 *   DC_SUBAGENT_CHAT_ID  chat id  (used in hello)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import {
  encodeFrame,
  parseServerFrame,
  type ServerMessage,
} from '../shared/protocol.js'

interface ToolDef {
  name: string
  description: string
  inputSchema: unknown
}

const MANIFEST_PATH = process.env.DC_TOOLS_MANIFEST
const SOCKET_PATH = process.env.DC_DISPATCHER_SOCKET
const SECRET = process.env.DC_DISPATCHER_SECRET
const SUBAGENT_ID = process.env.DC_SUBAGENT_ID
const CHAT_ID_RAW = process.env.DC_SUBAGENT_CHAT_ID

if (!MANIFEST_PATH || !SOCKET_PATH || !SECRET || !SUBAGENT_ID || !CHAT_ID_RAW) {
  process.stderr.write('tools-proxy: missing required env (DC_TOOLS_MANIFEST/DC_DISPATCHER_SOCKET/DC_DISPATCHER_SECRET/DC_SUBAGENT_ID/DC_SUBAGENT_CHAT_ID)\n')
  process.exit(2)
}
const CHAT_ID = Number(CHAT_ID_RAW)

const tools: ToolDef[] = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))

async function callDispatcher(tool: string, args: Record<string, unknown>): Promise<{ ok: true; result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean } } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    let sock: Socket
    let buf = ''
    let helloed = false
    const id = randomBytes(8).toString('hex')
    const settle = (v: { ok: true; result: { content: Array<{ type: 'text'; text: string }>; isError?: boolean } } | { ok: false; error: string }) => {
      try { sock.end() } catch {}
      resolve(v)
    }
    try {
      sock = connect(SOCKET_PATH!)
    } catch (err) {
      resolve({ ok: false, error: `connect failed: ${err}` })
      return
    }
    sock.on('connect', () => {
      sock.write(encodeFrame({
        kind: 'hello',
        secret: SECRET!,
        role: 'tools',
        chatId: CHAT_ID,
        subagentId: SUBAGENT_ID!,
      }))
    })
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf-8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const frame: ServerMessage | null = parseServerFrame(line)
        if (!frame) {
          settle({ ok: false, error: 'malformed server frame' })
          return
        }
        if (frame.kind === 'helloAck') {
          helloed = true
          sock.write(encodeFrame({ kind: 'toolCall', id, tool, args }))
          continue
        }
        if (frame.kind === 'toolResult' && frame.id === id) {
          settle({ ok: true, result: frame.result })
          return
        }
        if (frame.kind === 'toolError') {
          settle({ ok: false, error: `${frame.error.code}: ${frame.error.message}` })
          return
        }
      }
    })
    sock.on('error', (err) => {
      settle({ ok: false, error: `socket error: ${err.message}` })
    })
    sock.on('close', () => {
      if (!helloed) settle({ ok: false, error: 'connection closed before hello' })
    })
  })
}

const mcp = new Server(
  { name: 'dc', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as { type: 'object' },
  })),
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const out = await callDispatcher(req.params.name, args)
  if (out.ok) return out.result
  return {
    content: [{ type: 'text' as const, text: `dc tools-proxy: ${out.error}` }],
    isError: true,
  }
})

await mcp.connect(new StdioServerTransport())
