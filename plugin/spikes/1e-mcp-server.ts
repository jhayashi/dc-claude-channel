#!/usr/bin/env bun
/**
 * Spike 1E MCP server. Implements a single tool `noop` AND attempts to
 * register itself as a permission channel using whatever the MCP SDK
 * exposes. Records every received message to /tmp/spike-1e-server.log
 * so the driver can grep for permission frames after the run.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync } from 'node:fs'

const LOG = '/tmp/spike-1e-server.log'
function log(label: string, data: unknown): void {
  appendFileSync(LOG, `[${new Date().toISOString()}] ${label}: ${JSON.stringify(data)}\n`)
}

const server = new Server(
  { name: 'spike-1e', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'noop', description: 'Returns ok', inputSchema: { type: 'object', properties: {} } }],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  log('callTool', req.params)
  return { content: [{ type: 'text', text: 'ok' }] }
})

const transport = new StdioServerTransport()
const origOnMsg = (transport as any).onmessage
;(transport as any).onmessage = (msg: unknown) => {
  log('inbound', msg)
  if (origOnMsg) origOnMsg.call(transport, msg)
}

await server.connect(transport)
log('start', { pid: process.pid })
