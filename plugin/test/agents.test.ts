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
