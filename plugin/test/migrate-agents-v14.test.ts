import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import YAML from 'yaml'
import * as agents from '../agents'
import * as bindings from '../bindings'
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

  test('refuses to migrate when both source and .legacy/ already exist', () => {
    // Simulate a partial-rollback / restored-backup state: a prior boot
    // successfully retired agents/ → agents.legacy/, then something
    // (backup tool, manual mv, partial revert) put fresh content back
    // into agents/. Running the loop would treat every entry as a fresh
    // collision and start suffix-chasing.
    writeLegacy('keep-me', { name: 'KeepMe', model: 'claude-sonnet-4-6', system: 'x' })
    // Pre-create the retire-target so the guard fires.
    mkdirSync(`${legacyDir}.legacy`, { recursive: true })
    writeFileSync(`${legacyDir}.legacy/previous-run-artifact.txt`, '')

    const result = migrateLegacyDefinitionYaml()

    // No migration ran.
    expect(result.migrated).toBe(0)
    expect(result.collisions).toEqual([])
    expect(result.bindingsRewritten).toBe(0)
    // Source dir is untouched — operator can inspect both dirs and
    // decide how to merge.
    expect(existsSync(join(legacyDir, 'keep-me', 'definition.yaml'))).toBe(true)
    expect(existsSync(`${legacyDir}.legacy/previous-run-artifact.txt`)).toBe(true)
  })
})

describe('migrateLegacyDefinitionYaml — binding rewrites on collision', () => {
  let root: string
  let legacyDir: string
  let newDir: string
  let bindingsDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dc-migrate-binding-'))
    legacyDir = join(root, 'channels', 'deltachat', 'agents')
    newDir = join(root, 'agents')
    bindingsDir = join(root, 'bindings')
    mkdirSync(legacyDir, { recursive: true })
    mkdirSync(newDir, { recursive: true })
    mkdirSync(bindingsDir, { recursive: true })
    setLegacyAgentsDir(legacyDir)
    agents.setAgentsDir(newDir)
    bindings.setBindingsDir(bindingsDir)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writeLegacy(id: string, def: Record<string, unknown>): void {
    const dir = join(legacyDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'definition.yaml'), YAML.stringify({ id, ...def }))
  }

  test('rewrites binding agentId when target agent is renamed on collision', () => {
    // Terminal CC already has `helper.md`.
    writeFileSync(
      join(newDir, 'helper.md'),
      '---\nname: helper\nmodel: claude-sonnet-4-6\ntools: mcp__dc\n---\n\nterminal CC helper\n',
    )
    // DC v1.3 also has a `helper` agent.
    writeLegacy('helper', {
      name: 'Helper',
      model: 'claude-opus-4-7',
      system: 'DC helper system prompt',
    })
    // DC has a binding pointing chat 42 at the legacy DC helper.
    bindings.saveBinding({
      chatId: 42,
      agentId: 'helper',
      sessionId: 'sess-001',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    const result = migrateLegacyDefinitionYaml()
    expect(result.collisions).toEqual(['helper'])

    // The DC binding must now point at `helper-dc`, not `helper` (which
    // is terminal CC's agent — a different definition).
    expect(bindings.getBinding(42)?.agentId).toBe('helper-dc')

    // Sanity: the migrated DC definition is at `helper-dc.md` with the
    // DC system prompt; terminal CC's helper.md is untouched.
    expect(agents.getAgent('helper-dc')?.body).toContain('DC helper system prompt')
    expect(agents.getAgent('helper')?.body).toContain('terminal CC helper')
  })

  test('leaves other bindings untouched', () => {
    // Pre-existing terminal CC helper triggers collision for `helper`.
    writeFileSync(
      join(newDir, 'helper.md'),
      '---\nname: helper\nmodel: claude-sonnet-4-6\ntools: mcp__dc\n---\n\nterminal CC helper\n',
    )
    writeLegacy('helper', { name: 'Helper', model: 'claude-sonnet-4-6', system: 'x' })
    writeLegacy('coder', { name: 'Coder', model: 'claude-sonnet-4-6', system: 'y' })

    // Two bindings: one to the colliding `helper`, one to the non-colliding `coder`.
    bindings.saveBinding({ chatId: 42, agentId: 'helper', createdAt: '2026-01-01T00:00:00Z' })
    bindings.saveBinding({ chatId: 99, agentId: 'coder',  createdAt: '2026-01-01T00:00:00Z' })

    migrateLegacyDefinitionYaml()

    expect(bindings.getBinding(42)?.agentId).toBe('helper-dc')
    // The non-colliding agent's binding is unchanged.
    expect(bindings.getBinding(99)?.agentId).toBe('coder')
  })

  test('no-op when there are no collisions', () => {
    writeLegacy('uncontested', { name: 'Uncontested', model: 'claude-sonnet-4-6', system: 'x' })
    bindings.saveBinding({ chatId: 7, agentId: 'uncontested', createdAt: '2026-01-01T00:00:00Z' })
    const result = migrateLegacyDefinitionYaml()
    expect(result.collisions).toEqual([])
    expect(bindings.getBinding(7)?.agentId).toBe('uncontested')
  })

  test('preserves other binding fields (sessionId, workingDir, createdAt)', () => {
    writeFileSync(
      join(newDir, 'helper.md'),
      '---\nname: helper\nmodel: claude-sonnet-4-6\ntools: mcp__dc\n---\n\nterminal\n',
    )
    writeLegacy('helper', { name: 'Helper', model: 'claude-sonnet-4-6', system: 'x' })
    bindings.saveBinding({
      chatId: 42,
      agentId: 'helper',
      sessionId: 'sess-keepme',
      workingDir: '/path/to/work',
      inheritClaudeMd: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    migrateLegacyDefinitionYaml()

    const after = bindings.getBinding(42)!
    expect(after.agentId).toBe('helper-dc')
    expect(after.sessionId).toBe('sess-keepme')
    expect(after.workingDir).toBe('/path/to/work')
    expect(after.inheritClaudeMd).toBe(true)
    expect(after.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
