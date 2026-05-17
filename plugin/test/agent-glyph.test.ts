import { describe, test, expect, beforeAll } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODEL_COLORS,
  ARCHETYPE_PALETTES,
  ARCHETYPE_DEFAULT_GLYPH,
  type ModelFamily,
} from '../agent-icons/palettes'
import * as agents from '../agents'

const testDir = mkdtempSync(join(tmpdir(), 'dc-glyph-helpers-'))
beforeAll(() => agents.setAgentsDir(testDir))

function makeDef(overrides: Partial<agents.AgentDef> = {}): agents.AgentDef {
  return {
    name: 'glyph-test',
    description: '',
    model: 'claude-sonnet-4-6',
    tools: 'mcp__dc',
    body: 'you are helpful\n',
    ...overrides,
  }
}

describe('palettes', () => {
  test('every model family has solid + checker colors', () => {
    const families: ModelFamily[] = ['haiku', 'sonnet', 'opus']
    for (const f of families) {
      expect(MODEL_COLORS[f].solid).toMatch(/^#[0-9A-F]{6}$/)
      expect(MODEL_COLORS[f].checker).toMatch(/^#[0-9A-F]{6}$/)
    }
  })

  test('every archetype default is in its palette', () => {
    for (const arch of ['role', 'utility', 'project'] as const) {
      const def = ARCHETYPE_DEFAULT_GLYPH[arch]
      expect(ARCHETYPE_PALETTES[arch]).toContain(def)
    }
  })

  test('exact palette contents match the spec', () => {
    expect(ARCHETYPE_PALETTES.role).toEqual([
      'user-round', 'user-cog', 'crown', 'hard-hat',
      'glasses', 'mic-vocal', 'briefcase', 'graduation-cap',
    ])
    expect(ARCHETYPE_PALETTES.utility).toEqual([
      'cog', 'bot', 'zap', 'bell',
      'calendar', 'mail', 'search', 'terminal',
    ])
    expect(ARCHETYPE_PALETTES.project).toEqual([
      'folder-kanban', 'target', 'list-checks', 'route',
      'flag', 'clipboard-list', 'git-branch', 'package',
    ])
  })
})

describe('glyph helpers', () => {
  test('getGlyph returns null when not set', () => {
    expect(agents.getGlyph(makeDef())).toBeNull()
  })

  test('setGlyph writes, setGlyph(null) clears', () => {
    const def = makeDef()
    agents.setGlyph(def, 'calendar')
    expect(def['x-dc-glyph']).toBe('calendar')
    agents.setGlyph(def, null)
    expect(def['x-dc-glyph']).toBeUndefined()
  })

  test('setGlyph(empty string) clears', () => {
    const def = makeDef({ 'x-dc-glyph': 'cog' })
    agents.setGlyph(def, '')
    expect(def['x-dc-glyph']).toBeUndefined()
  })

  test('glyphForAgent falls back to archetype default when unset', () => {
    const role = makeDef()
    agents.setArchetype(role, 'role')
    expect(agents.glyphForAgent(role)).toBe('user-round')

    const util = makeDef()
    agents.setArchetype(util, 'utility')
    expect(agents.glyphForAgent(util)).toBe('cog')

    const proj = makeDef()
    agents.setArchetype(proj, 'project')
    expect(agents.glyphForAgent(proj)).toBe('folder-kanban')
  })

  test('glyphForAgent uses explicit glyph when in archetype palette', () => {
    const def = makeDef()
    agents.setArchetype(def, 'utility')
    agents.setGlyph(def, 'calendar')
    expect(agents.glyphForAgent(def)).toBe('calendar')
  })

  test('glyphForAgent ignores explicit glyph not in archetype palette and falls back', () => {
    const def = makeDef()
    agents.setArchetype(def, 'utility')
    agents.setGlyph(def, 'crown')
    expect(agents.glyphForAgent(def)).toBe('cog')
  })

  test('glyph round-trips through YAML', () => {
    const def = makeDef({ name: 'glyph-yaml' })
    agents.setArchetype(def, 'project')
    agents.setGlyph(def, 'route')
    agents.saveAgent(def)
    const loaded = agents.getAgent('glyph-yaml')
    expect(loaded).not.toBeNull()
    expect(agents.getGlyph(loaded!)).toBe('route')
    expect(agents.glyphForAgent(loaded!)).toBe('route')
  })
})
