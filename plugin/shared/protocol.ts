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
  args: z.record(z.string(), z.unknown()),
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
