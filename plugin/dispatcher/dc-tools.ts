import type { DCClient } from '../dc-client.js'
import type * as accessNs from '../access/index.js'
import type * as bindingsNs from '../bindings.js'
import type * as agentsNs from '../agents.js'

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** The small, broadly-shared dependency bundle pure tool handlers receive. */
export interface ToolCtx {
  client: DCClient
  access: typeof accessNs
  bindings: typeof bindingsNs
  agents: typeof agentsNs
  logf: (format: string, ...args: unknown[]) => void
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
  callerChatId?: number,
) => Promise<ToolResult>

export interface DcToolDef {
  name: string
  description: string
  requiresCapability?: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
  /** Present for pure tools; absent for tail tools handled by a server.ts closure. */
  handler?: ToolHandler
}

export const DC_TOOLS: readonly DcToolDef[] = []

/** All core tool names, derived from the registry. */
export function dcToolNames(): string[] {
  return DC_TOOLS.map(t => t.name)
}
