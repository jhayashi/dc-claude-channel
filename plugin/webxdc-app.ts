/**
 * WebXDC app plugin interface.
 *
 * Each WebXDC app implements this interface to register its tools,
 * event handlers, and notification handlers with server.ts.
 */

import type { DCClient, WebXDCUpdate } from './dc-client.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface AppContext {
  client: DCClient
  mcp: Server
  isAllowed: (chatId: number) => boolean
  allowedChats: () => number[]
  logf: (format: string, ...args: unknown[]) => void
  safeName: (s: string) => string
  /** Register a WebXDC msgId for event-driven update dispatch to the given app. */
  registerWebXDCMsg: (msgId: number, app: WebXDCApp, chatId: number) => void
  /** Unregister a WebXDC msgId (e.g. on session clear). */
  unregisterWebXDCMsg: (msgId: number) => void
  /** Evict a cached subagent for a chat so the next message triggers a respawn (e.g. after model change). */
  evictSubagent: (chatId: number) => Promise<void>
  /** Returns available MCP servers for the agent-setup tool picker. */
  getAvailableMcpServers: () => Array<{ prefix: string; label: string; toolCount: number }>
  /** Dispatch a synthetic user message to a chat's subagent and return the response text. */
  dispatchAndCollect?: (chatId: number, text: string) => Promise<string>
}

export interface WebXDCApp {
  id: string
  instructions?: string
  tools(): ToolDef[]
  callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null>
  /**
   * Called when owner-verified WebXDC updates arrive for a registered msgId.
   * Updates are pre-filtered by server.ts — only updates from the chat owner
   * (identified by senderAddr in the payload) are passed through.
   * Apps receive the already-read updates; do NOT call getWebXDCUpdates again.
   */
  onWebXDCUpdate?(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void>
  registerNotifications?(ctx: AppContext): void
  start?(ctx: AppContext): void
  stop?(): void
}
