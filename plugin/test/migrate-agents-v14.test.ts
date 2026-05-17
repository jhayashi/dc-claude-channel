import { describe, test, expect } from 'bun:test'
import { mapLegacyToNew, type LegacyAgentDef } from '../migrate-agents-v14'
import { ALL_BUILTIN_TOOLS } from '../dispatcher/subagent-process'

function legacy(overrides: Partial<LegacyAgentDef> = {}): LegacyAgentDef {
  return {
    id: 'test',
    name: 'Test',
    model: 'claude-sonnet-4-6',
    description: '',
    system: 'be helpful',
    tools: [],
    ...overrides,
  }
}

describe('mapLegacyToNew', () => {
  test('maps id → name', () => {
    const out = mapLegacyToNew(legacy({ id: 'foo', name: 'Foo' }))
    expect(out.name).toBe('foo')
    expect(out['x-dc-display-name']).toBe('Foo')
  })

  test('omits x-dc-display-name when human name equals slug', () => {
    const out = mapLegacyToNew(legacy({ id: 'foo', name: 'foo' }))
    expect(out['x-dc-display-name']).toBeUndefined()
  })

  test('maps system → body', () => {
    const out = mapLegacyToNew(legacy({ system: 'You are X.\n\nDo Y.' }))
    expect(out.body).toBe('You are X.\n\nDo Y.')
  })

  test('promotes metadata.x-dc-icon → top-level x-dc-icon', () => {
    const out = mapLegacyToNew(legacy({ metadata: { 'x-dc-icon': '👤' } }))
    expect(out['x-dc-icon']).toBe('👤')
  })

  test('promotes all x-dc-* metadata to top-level', () => {
    const out = mapLegacyToNew(legacy({
      metadata: {
        'x-dc-icon': '👤',
        'x-dc-glyph': 'cog',
        'x-dc-pattern': 'quartered',
        'x-dc-archetype': 'utility',
        'x-dc-iconMirror': true,
      },
    }))
    expect(out['x-dc-icon']).toBe('👤')
    expect(out['x-dc-glyph']).toBe('cog')
    expect(out['x-dc-pattern']).toBe('quartered')
    expect(out['x-dc-archetype']).toBe('utility')
    expect(out['x-dc-icon-mirror']).toBe(true)
  })

  test('metadata.x-dc-skipPermissions: true → permissionMode: bypassPermissions', () => {
    const out = mapLegacyToNew(legacy({ metadata: { 'x-dc-skipPermissions': true } }))
    expect(out.permissionMode).toBe('bypassPermissions')
  })

  test('absent skipPermissions does NOT set permissionMode', () => {
    const out = mapLegacyToNew(legacy({}))
    expect(out.permissionMode).toBeUndefined()
  })

  test('allowedBuiltinTools + allowedMcpServers → tools CSV', () => {
    const out = mapLegacyToNew(legacy({
      allowedBuiltinTools: ['Read', 'Bash'],
      allowedMcpServers: ['dc', 'claude_ai_Gmail'],
    }))
    expect(out.tools.split(',').map(s => s.trim()).sort()).toEqual(
      ['Bash', 'Read', 'mcp__claude_ai_Gmail', 'mcp__dc'].sort(),
    )
  })

  test('absent allowedBuiltinTools defaults to ALL_BUILTIN_TOOLS minus spawn tools', () => {
    const out = mapLegacyToNew(legacy({ allowedMcpServers: ['dc'] }))
    const tools = out.tools.split(',').map(s => s.trim())
    // Subagent-spawn tools (Task/TaskOutput/TaskStop — `Agent` is a deprecated
    // alias for Task and is not in ALL_BUILTIN_TOOLS) are excluded per spec §6.3.
    const SPAWN = new Set(['Task', 'TaskOutput', 'TaskStop'])
    for (const t of ALL_BUILTIN_TOOLS) {
      if (SPAWN.has(t)) {
        expect(tools).not.toContain(t)
        continue
      }
      expect(tools).toContain(t)
    }
    expect(tools).toContain('mcp__dc')
  })

  test('absent allowedMcpServers includes mcp__dc anyway', () => {
    const out = mapLegacyToNew(legacy({}))
    expect(out.tools).toContain('mcp__dc')
  })

  test('legacy allowedMcpTools (deprecated) is treated as allowedMcpServers=[dc] when non-empty', () => {
    const out = mapLegacyToNew(legacy({ allowedMcpTools: ['mcp__dc__dc_reply'] }))
    expect(out.tools).toContain('mcp__dc')
  })

  test('default memory: user is injected', () => {
    const out = mapLegacyToNew(legacy({}))
    expect(out.memory).toBe('user')
  })

  test('explicit effort field preserved', () => {
    const out = mapLegacyToNew(legacy({ effort: 'high' }))
    expect(out.effort).toBe('high')
  })

  test('empty description preserved as empty string (not omitted)', () => {
    const out = mapLegacyToNew(legacy({ description: '' }))
    expect(out.description).toBe('')
  })
})
