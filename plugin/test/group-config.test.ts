import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as groups from '../groups'

const testDir = mkdtempSync(join(tmpdir(), 'dc-groups-test-'))

beforeAll(() => groups.setGroupsDir(testDir))
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

describe('groups config', () => {
  test('round-trips a full config', () => {
    const cfg = groups.draftConfigFromDescription('help me debug this typescript repo')
    groups.setGroupContext(101, cfg)
    const loaded = groups.getGroupContext(101)
    expect(loaded).toEqual(cfg)
  })

  test('returns null for missing chat', () => {
    expect(groups.getGroupContext(999999)).toBeNull()
  })

  test('rejects invalid schema on save', () => {
    expect(() =>
      groups.setGroupContext(102, { type: 'bogus' } as unknown as groups.GroupContext),
    ).toThrow()
  })

  test('migrates legacy {name, prompt} files on read', () => {
    writeFileSync(
      join(testDir, '103.json'),
      JSON.stringify({ name: 'Old Group', prompt: 'be helpful' }),
    )
    const loaded = groups.getGroupContext(103)
    expect(loaded).not.toBeNull()
    expect(loaded!.name).toBe('Old Group')
    expect(loaded!.systemPrompt).toBe('be helpful')
    expect(loaded!.type).toBe('basic')
    expect(loaded!.model).toBe('claude-sonnet-4-6')
    expect(loaded!.inheritClaudeMd).toBe(true)
  })

  test('updateGroupPrompt edits systemPrompt in place', () => {
    const cfg = groups.draftConfigFromDescription('quick questions')
    groups.setGroupContext(104, cfg)
    expect(groups.updateGroupPrompt(104, 'new prompt')).toBe(true)
    expect(groups.getGroupContext(104)!.systemPrompt).toBe('new prompt')
  })

  test('updateGroupPrompt returns false for missing group', () => {
    expect(groups.updateGroupPrompt(888888, 'x')).toBe(false)
  })

  test('draftConfigFromDescription guesses type by keywords', () => {
    expect(groups.draftConfigFromDescription('debug a python bug').type).toBe('coding')
    expect(groups.draftConfigFromDescription('refactor the auth module').type).toBe('coding')
    expect(groups.draftConfigFromDescription('quick questions about anything').type).toBe('quick')
    expect(groups.draftConfigFromDescription('chat about books').type).toBe('basic')
  })

  test('draft assigns matching model and prompt for type', () => {
    const coding = groups.draftConfigFromDescription('typescript bug')
    expect(coding.model).toBe('claude-opus-4-6')
    expect(coding.systemPrompt).toBe(groups.GROUP_TYPES.coding.defaultPrompt)

    const quick = groups.draftConfigFromDescription('quick QA')
    expect(quick.model).toBe('claude-haiku-4-5')

    const basic = groups.draftConfigFromDescription('chat about books')
    expect(basic.model).toBe('claude-sonnet-4-6')
  })
})
