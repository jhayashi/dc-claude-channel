/**
 * Static configuration for the runtime agent badge renderer. Maps model
 * families to color tokens and archetypes to curated Lucide glyph palettes.
 *
 * Adding a glyph: drop the SVG into glyphs/, then add its name to the
 * appropriate ARCHETYPE_PALETTES array.
 *
 * Adding a model family: add an entry to MODEL_COLORS and update
 * ModelFamily union. The existing tierForModel() in plugin/models.ts
 * may also need an update if the new family should be auto-detected.
 */

export type ModelFamily = 'haiku' | 'sonnet' | 'opus'

export interface ModelPalette {
  /** Solid background hex color. */
  solid: string
  /** Same-hue partner hex used for the trust checker pattern. */
  checker: string
}

export const MODEL_COLORS: Record<ModelFamily, ModelPalette> = {
  haiku: { solid: '#3DA85A', checker: '#65C081' },
  sonnet: { solid: '#B4862A', checker: '#D9B25B' },
  opus: { solid: '#D97757', checker: '#F2A778' },
}

export const ARCHETYPE_PALETTES = {
  role: [
    'user-round', 'user-cog', 'crown', 'hard-hat',
    'glasses', 'mic-vocal', 'briefcase', 'graduation-cap',
  ],
  utility: [
    'cog', 'bot', 'zap', 'bell',
    'calendar', 'mail', 'search', 'terminal',
  ],
  project: [
    'folder-kanban', 'target', 'list-checks', 'route',
    'flag', 'clipboard-list', 'git-branch', 'package',
  ],
} as const

export const ARCHETYPE_DEFAULT_GLYPH = {
  role: 'user-round',
  utility: 'cog',
  project: 'folder-kanban',
} as const
