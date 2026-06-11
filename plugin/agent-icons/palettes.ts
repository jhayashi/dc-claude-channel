/**
 * Static configuration for the runtime agent badge renderer. Maps model
 * tiers to color tokens and archetypes to curated Lucide glyph palettes.
 *
 * Adding a glyph: drop the SVG into glyphs/, then add its name to the
 * appropriate ARCHETYPE_PALETTES array.
 *
 * Adding a tier color: add an entry to MODEL_COLORS keyed by the tier
 * string. v1.4.11 dropped the ModelFamily union — tier is now opaque
 * string (see plugin/models.ts:tierForModel). Unknown tiers (anything
 * not registered below) fall back to UNKNOWN_MODEL_COLOR at the
 * renderer caller, so adding a color is *optional* — the picker accepts
 * any model ID without it.
 */

/**
 * Kept for backwards-compat with v1.4.x consumers that imported the
 * type alias. v1.4.11 makes it equivalent to `string` so non-canonical
 * tiers (fable, future Anthropic releases) typecheck. Remove in v1.5.0.
 */
export type ModelFamily = string

export interface ModelPalette {
  /** Solid background hex color. */
  solid: string
  /** Same-hue partner hex used for the trust checker pattern. */
  checker: string
}

export const MODEL_COLORS: Record<string, ModelPalette> = {
  haiku: { solid: '#B4862A', checker: '#D9B25B' },
  sonnet: { solid: '#3DA85A', checker: '#65C081' },
  opus: { solid: '#D97757', checker: '#F2A778' },
  // v1.4.12 — Fable becomes an officially supported tier (Claude Fable 5,
  // anthropic.com 2026-06-09). Deep purple per Joe's call: Violet-700
  // solid / Violet-400 checker — dark-solid + lighter-same-hue, matching
  // the established palette pattern.
  fable: { solid: '#6D28D9', checker: '#A78BFA' },
}

/**
 * v1.4.11 fallback for tiers not registered in MODEL_COLORS — e.g.,
 * a user-typed `claude-fable-1-0` in the picker. Zinc-700 solid /
 * Zinc-600 checker: a neutral dark grey that reads as "not categorized"
 * without competing with the registered-tier palette.
 */
export const UNKNOWN_MODEL_COLOR: ModelPalette = {
  solid: '#3F3F46',
  checker: '#52525B',
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

/**
 * Eight visually distinct background patterns available for trust-on
 * agents. The renderer dispatches on this field; trust-off agents
 * always render as a single solid color regardless of pattern.
 *
 * - checker: 2x2 alternating squares (legacy default)
 * - mini-checker: 8x8 denser checker
 * - stripes: 4 horizontal bands
 * - v-stripes: 4 vertical bands
 * - quartered: heraldic four squares
 * - quartered-x: four triangles meeting at center
 * - dots: 4x4 grid of small dots
 * - big-dots: 2x2 grid of large dots
 */
export const PATTERN_IDS = [
  'checker',
  'mini-checker',
  'stripes',
  'v-stripes',
  'quartered',
  'quartered-x',
  'dots',
  'big-dots',
] as const

export type PatternId = (typeof PATTERN_IDS)[number]

/**
 * Pick one of PATTERN_IDS uniformly at random. Used at the moment trust
 * (skip-permissions) is enabled on an agent — each trust-on transition
 * rolls a fresh pattern so visually-similar same-tier agents diverge.
 * Trust-off agents render as a solid color regardless of pattern, so
 * the value is only visually meaningful while trust is on.
 */
export function randomPatternId(): PatternId {
  return PATTERN_IDS[Math.floor(Math.random() * PATTERN_IDS.length)]
}
