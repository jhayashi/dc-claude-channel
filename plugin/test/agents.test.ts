import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as agents from '../agents'

const testDir = mkdtempSync(join(tmpdir(), 'dc-agents-test-'))

beforeAll(() => agents.setAgentsDir(testDir))
beforeEach(() => {
  if (existsSync(testDir)) {
    for (const f of readdirSync(testDir)) {
      rmSync(join(testDir, f), { recursive: true, force: true })
    }
  }
})
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

function makeDef(overrides: Partial<agents.AgentDef> = {}): agents.AgentDef {
  return {
    name: 'test-agent',
    description: '',
    model: 'claude-sonnet-4-6',
    tools: 'Read, Bash, mcp__dc',
    body: 'you are helpful',
    ...overrides,
  }
}

describe('AgentDef schema', () => {
  test('accepts a minimal valid definition', () => {
    expect(() => agents.AgentDefSchema.parse(makeDef())).not.toThrow()
  })

  test('rejects a non-slug name', () => {
    expect(() => agents.AgentDefSchema.parse(makeDef({ name: 'Has Capitals' }))).toThrow()
  })

  test('rejects an unknown model', () => {
    expect(() => agents.AgentDefSchema.parse(makeDef({ model: 'not-a-real-model' }))).toThrow()
  })

  test('accepts top-level x-dc-* extensions', () => {
    const def = makeDef({
      'x-dc-archetype': 'utility',
      'x-dc-icon': '🛠️',
      'x-dc-pattern': 'quartered',
      'x-dc-icon-mirror': true,
    })
    expect(() => agents.AgentDefSchema.parse(def)).not.toThrow()
  })

  test('accepts permissionMode bypassPermissions', () => {
    expect(() =>
      agents.AgentDefSchema.parse(makeDef({ permissionMode: 'bypassPermissions' })),
    ).not.toThrow()
  })

  test('accepts pass-through fields (skills, hooks, maxTurns, etc.)', () => {
    const def = makeDef({
      skills: ['api-conventions'],
      hooks: { PreToolUse: [] },
      maxTurns: 50,
      background: true,
      isolation: 'worktree',
      initialPrompt: '/foo',
    })
    expect(() => agents.AgentDefSchema.parse(def)).not.toThrow()
  })
})

describe('saveAgent / getAgent round-trip', () => {
  test('round-trips a full definition through .md', () => {
    const def = makeDef({
      name: 'round-trip',
      description: 'a description',
      tools: 'Read, Bash, mcp__dc',
      permissionMode: 'bypassPermissions',
      memory: 'user',
      effort: 'high',
      color: 'blue',
      'x-dc-archetype': 'role',
      'x-dc-icon': '👤',
      'x-dc-pattern': 'quartered',
      // body terminates with \n — serialize emits a trailing newline; parse
      // preserves it verbatim, so round-trip equality requires the input to
      // already have one.
      body: 'You are a senior engineer.\n\nFollow conventions.\n',
    })
    agents.saveAgent(def)
    expect(agents.getAgent('round-trip')).toEqual(def)
  })

  test('saved file is at <name>.md and contains frontmatter + body', () => {
    const def = makeDef({ name: 'disk-agent', body: 'be quick' })
    agents.saveAgent(def)
    const contents = readFileSync(join(testDir, 'disk-agent.md'), 'utf-8')
    expect(contents.startsWith('---\n')).toBe(true)
    expect(contents).toContain('name: disk-agent')
    expect(contents).toContain('model: claude-sonnet-4-6')
    expect(contents).toContain('be quick')
  })

  test('getAgent returns null for missing name', () => {
    expect(agents.getAgent('nonexistent')).toBeNull()
  })

  test('getAgent returns null for unparseable file', () => {
    writeFileSync(join(testDir, 'broken.md'), '::: not: [valid frontmatter')
    expect(agents.getAgent('broken')).toBeNull()
  })

  test('getAgent returns null for schema-invalid file', () => {
    writeFileSync(
      join(testDir, 'bad.md'),
      '---\nname: bad\n---\nbody only, no model',
    )
    expect(agents.getAgent('bad')).toBeNull()
  })

  test('rejects invalid schema on save', () => {
    expect(() =>
      agents.saveAgent({ name: 'invalid' } as unknown as agents.AgentDef),
    ).toThrow()
  })

  test('rejects name that is not a lowercase slug', () => {
    expect(() => agents.saveAgent(makeDef({ name: 'Has Capitals' }))).toThrow()
  })
})

describe('listAgents', () => {
  test('returns all agents sorted by name', () => {
    agents.saveAgent(makeDef({ name: 'zebra' }))
    agents.saveAgent(makeDef({ name: 'apple' }))
    agents.saveAgent(makeDef({ name: 'mango' }))
    // ensureDefaultAgent auto-seeds claude-code on listAgents; expect 4.
    const names = agents.listAgents().map(a => a.name)
    expect(names).toEqual(['apple', 'claude-code', 'mango', 'zebra'])
  })

  test('auto-seeds the default agent when none exist', () => {
    const list = agents.listAgents()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('claude-code')
  })

  test('skips invalid .md files', () => {
    agents.saveAgent(makeDef({ name: 'ok' }))
    writeFileSync(join(testDir, 'broken.md'), 'not even frontmatter')
    const names = agents.listAgents().map(a => a.name)
    expect(names).toContain('ok')
    expect(names).not.toContain('broken')
  })

  test('ignores non-.md entries (sidecar dirs, README, etc.)', () => {
    agents.saveAgent(makeDef({ name: 'real' }))
    mkdirSync(join(testDir, 'real.dc', 'contacts'), { recursive: true })
    writeFileSync(join(testDir, 'real.dc', 'contacts', '1.json'), '{}')
    writeFileSync(join(testDir, 'README.txt'), 'hi')
    const names = agents.listAgents().map(a => a.name)
    expect(names).toContain('real')
    expect(names).not.toContain('real.dc')
    expect(names).not.toContain('README')
  })
})

describe('synthesizeAgentName', () => {
  test('returns the bare slug when no collision', () => {
    expect(agents.synthesizeAgentName('Marketing Agent')).toBe('marketing-agent')
  })

  test('suffixes -2, -3 on collision', () => {
    agents.saveAgent(makeDef({ name: 'helper' }))
    expect(agents.synthesizeAgentName('Helper')).toBe('helper-2')
    agents.saveAgent(makeDef({ name: 'helper-2' }))
    expect(agents.synthesizeAgentName('Helper')).toBe('helper-3')
  })

  test('handles empty input', () => {
    expect(agents.synthesizeAgentName('')).toBe('agent')
  })
})

describe('mcp__dc auto-injection', () => {
  test('adds mcp__dc to tools when absent on save', () => {
    agents.saveAgent(makeDef({ name: 'no-dc', tools: 'Read, Bash' }))
    const reloaded = agents.getAgent('no-dc')
    expect(reloaded?.tools).toContain('mcp__dc')
    expect(reloaded?.tools).toContain('Read')
    expect(reloaded?.tools).toContain('Bash')
  })

  test('leaves mcp__dc alone when already present', () => {
    agents.saveAgent(makeDef({ name: 'has-dc', tools: 'Read, mcp__dc, Bash' }))
    const reloaded = agents.getAgent('has-dc')
    const matches = (reloaded?.tools ?? '').match(/mcp__dc/g) ?? []
    expect(matches.length).toBe(1)
  })

  test('handles empty tools CSV by initialising to mcp__dc', () => {
    agents.saveAgent(makeDef({ name: 'empty', tools: '' }))
    expect(agents.getAgent('empty')?.tools).toBe('mcp__dc')
  })
})

describe('metadata accessors against top-level frontmatter', () => {
  test('getSkipPermissions reads permissionMode === bypassPermissions', () => {
    const def = makeDef({ permissionMode: 'bypassPermissions' })
    expect(agents.getSkipPermissions(def)).toBe(true)
    const def2 = makeDef({ permissionMode: 'default' })
    expect(agents.getSkipPermissions(def2)).toBe(false)
    expect(agents.getSkipPermissions(makeDef())).toBe(false)
  })

  test('setSkipPermissions(true) writes permissionMode: bypassPermissions and rolls pattern', () => {
    const def = makeDef()
    agents.setSkipPermissions(def, true)
    expect(def.permissionMode).toBe('bypassPermissions')
    expect(def['x-dc-pattern']).toBeDefined()
  })

  test('setSkipPermissions(false) deletes the permissionMode field', () => {
    const def = makeDef({ permissionMode: 'bypassPermissions', 'x-dc-pattern': 'quartered' })
    agents.setSkipPermissions(def, false)
    expect(def.permissionMode).toBeUndefined()
    // Pattern is preserved — only trust toggles affect it.
    expect(def['x-dc-pattern']).toBe('quartered')
  })

  test('getArchetype reads top-level x-dc-archetype with role fallback', () => {
    expect(agents.getArchetype(makeDef())).toBe('role')
    expect(agents.getArchetype(makeDef({ 'x-dc-archetype': 'utility' }))).toBe('utility')
  })

  test('setArchetype writes top-level field; setting role clears the key', () => {
    const def = makeDef({ 'x-dc-archetype': 'utility' })
    agents.setArchetype(def, 'role')
    expect(def['x-dc-archetype']).toBeUndefined()
    agents.setArchetype(def, 'project')
    expect(def['x-dc-archetype']).toBe('project')
  })

  test('iconForAgent returns explicit x-dc-icon or archetype default', () => {
    expect(agents.iconForAgent(makeDef({ 'x-dc-icon': '🛠️' }))).toBe('🛠️')
    expect(agents.iconForAgent(makeDef({ 'x-dc-archetype': 'utility' }))).toBe('⚙️')
  })

  test('getIconMirror reads top-level x-dc-icon-mirror', () => {
    expect(agents.getIconMirror(makeDef())).toBe(false)
    expect(agents.getIconMirror(makeDef({ 'x-dc-icon-mirror': true }))).toBe(true)
  })
})

describe('lintSidecarDirs', () => {
  test('returns empty list when no sidecar dirs exist', () => {
    expect(agents.lintSidecarDirs()).toEqual([])
  })

  test('reports stray .md files inside <name>.dc/ subtrees', () => {
    mkdirSync(join(testDir, 'foo.dc', 'contacts'), { recursive: true })
    writeFileSync(join(testDir, 'foo.dc', 'contacts', 'stray.md'), '---\nname: stray\n---\n')
    writeFileSync(join(testDir, 'foo.dc', 'top-level.md'), '---\nname: top\n---\n')
    const stray = agents.lintSidecarDirs()
    expect(stray).toHaveLength(2)
    expect(stray.some(p => p.endsWith('stray.md'))).toBe(true)
    expect(stray.some(p => p.endsWith('top-level.md'))).toBe(true)
  })

  test('ignores .json files inside sidecar dirs', () => {
    mkdirSync(join(testDir, 'bar.dc', 'contacts'), { recursive: true })
    writeFileSync(join(testDir, 'bar.dc', 'contacts', '1.json'), '{}')
    expect(agents.lintSidecarDirs()).toEqual([])
  })

  test('only inspects subtrees with the .dc extension', () => {
    // Plain agent .md file at top level should NOT be reported.
    agents.saveAgent(makeDef({ name: 'real' }))
    // A sibling directory not ending in .dc should be ignored entirely.
    mkdirSync(join(testDir, 'other-stuff'), { recursive: true })
    writeFileSync(join(testDir, 'other-stuff', 'thing.md'), '---\nname: x\n---\n')
    expect(agents.lintSidecarDirs()).toEqual([])
  })
})
