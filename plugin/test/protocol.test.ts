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
