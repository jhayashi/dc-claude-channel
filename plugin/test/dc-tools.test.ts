import { describe, test, expect } from 'bun:test'
import { DC_TOOLS, type ToolCtx } from '../dispatcher/dc-tools'

/**
 * Build a ToolCtx whose members throw unless a test overrides them, so each
 * handler test stubs only the surface it exercises.
 */
export function makeToolCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const trap = (name: string) =>
    new Proxy({}, { get: () => () => { throw new Error(`ToolCtx.${name} not stubbed`) } })
  return {
    client: trap('client') as ToolCtx['client'],
    access: trap('access') as ToolCtx['access'],
    bindings: trap('bindings') as ToolCtx['bindings'],
    agents: trap('agents') as ToolCtx['agents'],
    logf: () => {},
    ...overrides,
  }
}

describe('DC_TOOLS registry', () => {
  test('tool names are unique', () => {
    const names = DC_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

test('reply sends to an allowed chat and returns the message id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'reply')!
  const sent: Array<[number, string]> = []
  const ctx = makeToolCtx({
    access: { isAllowed: (id: number) => id === 42 } as unknown as ToolCtx['access'],
    client: { send: async (id: number, text: string) => { sent.push([id, text]); return 7 } } as unknown as ToolCtx['client'],
  })
  const ok = await def.handler!({ chat_id: '42', text: 'hi' }, ctx)
  expect(ok).toEqual({ content: [{ type: 'text', text: 'sent (id: 7)' }] })
  expect(sent).toEqual([[42, 'hi']])
  const denied = await def.handler!({ chat_id: '99', text: 'hi' }, ctx)
  expect(denied.isError).toBe(true)
})
