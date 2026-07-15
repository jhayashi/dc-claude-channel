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
  /**
   * Capability category required to invoke this tool (v1.3+).
   *
   * Resolved against the originator's capability bundle by the dispatcher's
   * capability gate (`plugin/access/gate.ts`). Tools without
   * an annotation are treated as `chat`-tier (the safest default for
   * tools that read non-private data and post chat-shaped messages).
   *
   * Vocabulary (v1.3.0): `chat` | `low_stakes_chat` | `private_data_read`
   * | `private_data_write` | `real_world_action` | `infrastructure`.
   * See `plugin/access/capability-bundles.ts` for the role → bundle map.
   *
   * Slice 3 (observability): the dispatcher logs every tool call with
   * the resolved decision (`allow` / `would_deny`) but does NOT enforce.
   * Slice 4 flips `would_deny` to a hard refuse.
   */
  requiresCapability?: string
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
  /** Register a WebXDC msgId for event-driven update dispatch to the given app.
   *  Optional lastSerial seeds the serial tracker so restarts don't replay old updates. */
  registerWebXDCMsg: (msgId: number, app: WebXDCApp, chatId: number, lastSerial?: number) => void
  /** Unregister a WebXDC msgId (e.g. on session clear). */
  unregisterWebXDCMsg: (msgId: number) => void
  /** Evict a cached subagent for a chat so the next message triggers a respawn (e.g. after model change). */
  evictSubagent: (chatId: number) => Promise<void>
  /** Returns available MCP servers for the agent-setup tool picker. */
  getAvailableMcpServers: () => Array<{ prefix: string; label: string; toolCount?: number }>
  /** Returns MCP server prefixes considered "connected" (usable without further auth). */
  getConnectedMcpServers: () => string[]
  /** Dispatch a synthetic user message to a chat's subagent and return the response text. */
  dispatchAndCollect?: (chatId: number, text: string) => Promise<string>
  /**
   * Dispatch a synthetic user message AND post the turn's final text +
   * policy-denial summary back to the chat (#128). Use this — not
   * dispatchAndCollect — whenever the user is meant to see the outcome;
   * dispatchAndCollect is only for callers that consume the text
   * themselves (e.g. familiar's requestLLM).
   */
  dispatchAndPost?: (chatId: number, text: string) => Promise<void>
  /** Per-chat scheduled-job store. Populated by server.ts at startup. */
  scheduleStore: import('./dispatcher/schedule-store.js').ScheduleStore
  /** Subagent cache — used by teleport-out to evict before the command prints. */
  subagentCache: { evictChat(chatId: number): Promise<void> }
  /**
   * Shared chat-cleanup helper (file-reviewer, familiar, tutorial, schedules,
   * binding, access, optionally leave/delete the DC chat). Wraps the
   * module-level helper in server.ts.
   */
  cleanupChatState: (chatId: number, opts: { chatAction: 'delete' | 'leave' | 'none'; reason: string }) => Promise<void>
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
  /**
   * #114: called at boot for each persisted card session so the app can
   * refill its module-level msgId→chatId map. Implement ONLY where a card's
   * session should survive restarts (permissions deliberately does not —
   * a pending permission request must die with the process).
   */
  restoreSession?(msgId: number, chatId: number): void
  start?(ctx: AppContext): void
  stop?(): void
}
