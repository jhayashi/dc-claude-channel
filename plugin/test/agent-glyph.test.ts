import { describe, test, expect } from 'bun:test'
import {
  MODEL_COLORS,
  ARCHETYPE_PALETTES,
  ARCHETYPE_DEFAULT_GLYPH,
  type ModelFamily,
} from '../agent-icons/palettes'

describe('palettes', () => {
  test('every model family has solid + checker colors', () => {
    const families: ModelFamily[] = ['haiku', 'sonnet', 'opus', 'slate']
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
