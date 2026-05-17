import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import YAML from 'yaml'
import * as agents from '../agents'
import {
  mapLegacyToNew,
  migrateLegacyDefinitionYaml,
  setLegacyAgentsDir,
  type LegacyAgentDef,
} from '../migrate-agents-v14'
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

describe('migrateLegacyDefinitionYaml', () => {
  let root: string
  let legacyDir: string
  let newDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-migrate-v14-'))
    legacyDir = join(root, 'channels', 'deltachat', 'agents')
    newDir = join(root, 'agents')
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(newDir, { recursive: true })
    setLegacyAgentsDir(legacyDir)
    agents.setAgentsDir(newDir)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeLegacy(id: string, def: Record<string, unknown>): void {
    const dir = join(legacyDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'definition.yaml'), YAML.stringify({ id, ...def }))
  }

  test('migrates a single agent to <name>.md and reads back via getAgent', () => {
    writeLegacy('foo', {
      name: 'Foo',
      model: 'claude-sonnet-4-6',
      system: 'be foo',
      tools: [],
      metadata: { 'x-dc-skipPermissions': true },
      allowedMcpServers: ['dc'],
    })
    const result = migrateLegacyDefinitionYaml()
    expect(result.migrated).toBe(1)
    expect(result.collisions).toEqual([])

    const reloaded = agents.getAgent('foo')
    expect(reloaded).not.toBeNull()
    expect(reloaded!.name).toBe('foo')
    // Migration writes body without trailing \n; serialize adds one;
    // parse preserves verbatim. Round-trip body is 'be foo\n'.
    expect(reloaded!.body).toBe('be foo\n')
    expect(reloaded!.permissionMode).toBe('bypassPermissions')
    expect(reloaded!.memory).toBe('user')
    expect(reloaded!.tools).toContain('mcp__dc')
  })

  test('migrates multiple agents in one run', () => {
    writeLegacy('alpha', { name: 'Alpha', model: 'claude-sonnet-4-6', system: 'a' })
    writeLegacy('bravo', { name: 'Bravo', model: 'claude-opus-4-7', system: 'b' })
    const result = migrateLegacyDefinitionYaml()
    expect(result.migrated).toBe(2)
    expect(agents.getAgent('alpha')?.body).toBe('a\n')
    expect(agents.getAgent('bravo')?.body).toBe('b\n')
  })

  test('is idempotent on second run', () => {
    writeLegacy('idem', { name: 'Idempotent', model: 'claude-sonnet-4-6', system: 'x' })
    expect(migrateLegacyDefinitionYaml().migrated).toBe(1)
    // First run renames legacyDir → legacyDir + '.legacy', so the next run is a no-op.
    expect(migrateLegacyDefinitionYaml().migrated).toBe(0)
  })

  test('collision: existing <name>.md → write <name>-dc.md and log', () => {
    // Pre-place a terminal-CC-style file at the target.
    writeFileSync(
      join(newDir, 'sharedname.md'),
      `---\nname: sharedname\nmodel: claude-sonnet-4-6\ntools: mcp__dc\n---\n\nfrom terminal CC\n`,
    )
    writeLegacy('sharedname', { name: 'Shared', model: 'claude-opus-4-7', system: 'from DC' })
    const result = migrateLegacyDefinitionYaml()
    expect(result.migrated).toBe(1)
    expect(result.collisions).toEqual(['sharedname'])

    // Terminal CC's file untouched.
    expect(readFileSync(join(newDir, 'sharedname.md'), 'utf-8')).toContain('from terminal CC')
    // DC's migrated copy lands at sharedname-dc.md with name: sharedname-dc.
    const dc = agents.getAgent('sharedname-dc')
    expect(dc).not.toBeNull()
    expect(dc!.body).toBe('from DC\n')
    expect(dc!.name).toBe('sharedname-dc')
  })

  test('moves contacts/<id>/contacts/ → <name>.dc/contacts/', () => {
    writeLegacy('mover', { name: 'Mover', model: 'claude-sonnet-4-6', system: 'x' })
    const contactsDir = join(legacyDir, 'mover', 'contacts')
    mkdirSync(contactsDir, { recursive: true })
    writeFileSync(join(contactsDir, '11.json'), JSON.stringify({
      kind: 'human', contactId: 11, firstPairedAt: '2026-01-01T00:00:00Z',
    }))

    migrateLegacyDefinitionYaml()

    const newContactsDir = join(newDir, 'mover.dc', 'contacts')
    expect(existsSync(newContactsDir)).toBe(true)
    expect(existsSync(join(newContactsDir, '11.json'))).toBe(true)
  })

  test('renames legacyDir → legacyDir.legacy after a successful run', () => {
    writeLegacy('one', { name: 'One', model: 'claude-sonnet-4-6', system: 'a' })
    migrateLegacyDefinitionYaml()
    expect(existsSync(legacyDir)).toBe(false)
    expect(existsSync(legacyDir + '.legacy')).toBe(true)
  })

  test('no-op when legacyDir does not exist', () => {
    rmSync(legacyDir, { recursive: true, force: true })
    const result = migrateLegacyDefinitionYaml()
    expect(result.migrated).toBe(0)
    expect(result.collisions).toEqual([])
  })

  test('skips entries that are not directories', () => {
    writeFileSync(join(legacyDir, 'stray-file.txt'), 'hi')
    writeLegacy('valid', { name: 'Valid', model: 'claude-sonnet-4-6', system: 'x' })
    const result = migrateLegacyDefinitionYaml()
    expect(result.migrated).toBe(1)
  })

  test('skips directories without definition.yaml', () => {
    mkdirSync(join(legacyDir, 'empty-dir'), { recursive: true })
    writeLegacy('real', { name: 'Real', model: 'claude-sonnet-4-6', system: 'x' })
    const result = migrateLegacyDefinitionYaml()
    expect(result.migrated).toBe(1)
  })
})
