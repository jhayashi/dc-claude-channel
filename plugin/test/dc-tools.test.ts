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
