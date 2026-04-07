/**
 * Regression test for v0.8.3 message-drop bug.
 *
 * dc-core returns systemMessageType='Unknown' (the SystemMessage enum
 * default) for regular text messages. Prior to the fix, the handler let
 * that string pass through, and the downstream `if (msg.systemMessageType)`
 * guard in server.ts treated every text message as a system message and
 * silently dropped it.
 */

import { describe, test, expect } from 'bun:test'
import { normalizeSystemMessageType } from '../dc-client.js'

describe('normalizeSystemMessageType', () => {
  test('undefined → undefined (no system message)', () => {
    expect(normalizeSystemMessageType(undefined)).toBeUndefined()
  })

  test('null → undefined', () => {
    expect(normalizeSystemMessageType(null)).toBeUndefined()
  })

  test('empty string → undefined', () => {
    expect(normalizeSystemMessageType('')).toBeUndefined()
  })

  test("'Unknown' → undefined (the regression)", () => {
    // This is the bug that dropped every text message in v0.8.3.
    expect(normalizeSystemMessageType('Unknown')).toBeUndefined()
  })

  test("'MemberRemovedFromGroup' → passes through", () => {
    expect(normalizeSystemMessageType('MemberRemovedFromGroup')).toBe('MemberRemovedFromGroup')
  })

  test("'GroupNameChanged' → passes through", () => {
    expect(normalizeSystemMessageType('GroupNameChanged')).toBe('GroupNameChanged')
  })

  test('simulated server.ts guard: normalized undefined is falsy', () => {
    // This is exactly what server.ts onIncomingMessage checks.
    const sysType = normalizeSystemMessageType('Unknown')
    expect(Boolean(sysType)).toBe(false)
  })

  test('simulated server.ts guard: real system type is truthy', () => {
    const sysType = normalizeSystemMessageType('MemberRemovedFromGroup')
    expect(Boolean(sysType)).toBe(true)
  })
})
