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
