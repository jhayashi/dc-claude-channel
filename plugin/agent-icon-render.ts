/**
 * Renders the per-agent chat profile image as a Technical Precision
 * badge: circular shell, hairline ring, paper-ink Lucide glyph centered
 * at 50%, on a model-colored background that is either solid (trust-off)
 * or one of eight two-tone same-hue patterns (trust-on / skip-permissions).
 * Patterns are listed in PATTERN_IDS — checker, mini-checker, stripes,
 * v-stripes, quartered, quartered-x, dots, big-dots.
 *
 * Outputs a 256x256 PNG and caches by deterministic key
 * `{archetype}-{family}-{trust}-{glyph}-{pattern}.png`. Same inputs reuse
 * the cached file; no re-render. Cache lives under
 * $DC_STATE_DIR/agent-badges/ (or the dispatcher's default state dir).
 *
 * Glyph SVGs are vendored Lucide files in ./agent-icons/glyphs/. The
 * renderer reads the source SVG, extracts the inner shape XML, and
 * splices it into the composed badge SVG so we can drive stroke color
 * and stroke width centrally.
 */

import { Resvg } from '@resvg/resvg-js'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Archetype } from './agents.js'
import {
  MODEL_COLORS,
  ARCHETYPE_DEFAULT_GLYPH,
  type ModelFamily,
  type PatternId,
} from './agent-icons/palettes.js'

export type { ModelFamily, PatternId } from './agent-icons/palettes.js'

export interface BadgeInputs {
  archetype: Archetype
  modelFamily: ModelFamily
  trust: boolean
  glyph: string
  pattern: PatternId
}

/** Generate a unique element ID for SVG <pattern> defs to avoid collision when multiple badges render in the same process. */
function uid(): string {
  return 'p' + Math.random().toString(36).slice(2, 9)
}

const GLYPHS_DIR = new URL('./agent-icons/glyphs/', import.meta.url).pathname

const PREBUILT_DIR = new URL('./agent-badges-prebuilt/', import.meta.url).pathname

let CACHE_DIR = process.env.DC_STATE_DIR
  ? join(process.env.DC_STATE_DIR, 'agent-badges')
  : join(homedir(), '.claude', 'channels', 'deltachat', 'agent-badges')

/** Override the cache directory (for tests). */
export function setBadgeCacheDir(dir: string): void {
  CACHE_DIR = dir
}

function cacheKey(i: BadgeInputs): string {
  const trust = i.trust ? 'trust' : 'plain'
  // Pattern only varies the trust-on output. Keeping the segment in both
  // cases keeps the key shape uniform and makes future migrations easier.
  return `${i.archetype}-${i.modelFamily}-${trust}-${i.glyph}-${i.pattern}.png`
}

const SVG_BODY_RE = /<svg[^>]*>([\s\S]*)<\/svg>/

function extractInner(svg: string): string {
  const match = svg.match(SVG_BODY_RE)
  if (!match) throw new Error('agent-icon-render: input is not a valid SVG')
  return match[1].trim()
}

function readGlyphInner(name: string, fallback: string): string {
  const candidate = join(GLYPHS_DIR, `${name}.svg`)
  if (existsSync(candidate)) {
    return extractInner(readFileSync(candidate, 'utf-8'))
  }
  const fallbackPath = join(GLYPHS_DIR, `${fallback}.svg`)
  return extractInner(readFileSync(fallbackPath, 'utf-8'))
}

function buildBadgeSvg(
  inner: string,
  solid: string,
  accent: string,
  pattern: PatternId,
  trust: boolean,
): string {
  if (!trust) {
    // Trust-off: single solid color, pattern is ignored.
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
      <defs><clipPath id="circle"><circle cx="128" cy="128" r="128"/></clipPath></defs>
      <g clip-path="url(#circle)">
        <rect width="256" height="256" fill="${solid}"/>
        <g transform="translate(64,64) scale(5.333)" stroke="#FAF9F5" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">
          ${inner}
        </g>
      </g>
      <circle cx="128" cy="128" r="127.5" fill="none" stroke="rgba(11,15,23,0.12)" stroke-width="1"/>
    </svg>`
  }
  const fillSvg = buildPatternFill(pattern, solid, accent)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
    <defs><clipPath id="circle"><circle cx="128" cy="128" r="128"/></clipPath></defs>
    <g clip-path="url(#circle)">
      ${fillSvg}
      <g transform="translate(64,64) scale(5.333)" stroke="#FAF9F5" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">
        ${inner}
      </g>
    </g>
    <circle cx="128" cy="128" r="127.5" fill="none" stroke="rgba(11,15,23,0.12)" stroke-width="1"/>
  </svg>`
}

/**
 * Emit the SVG fragment that paints the 256x256 background for a
 * trust-on badge. Returns either a `<defs><pattern>...</pattern></defs>`
 * + filling rect (for tile-based patterns) or a sequence of plain rects
 * / polygons / circles (for one-shot patterns). All use the same two
 * colors: `solid` and `accent`.
 */
function buildPatternFill(pattern: PatternId, solid: string, accent: string): string {
  const id = uid()
  switch (pattern) {
    case 'checker':
      return `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="128" height="128"><rect width="64" height="64" fill="${solid}"/><rect x="64" width="64" height="64" fill="${accent}"/><rect y="64" width="64" height="64" fill="${accent}"/><rect x="64" y="64" width="64" height="64" fill="${solid}"/></pattern></defs><rect width="256" height="256" fill="url(#${id})"/>`
    case 'mini-checker':
      return `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="64" height="64"><rect width="32" height="32" fill="${solid}"/><rect x="32" width="32" height="32" fill="${accent}"/><rect y="32" width="32" height="32" fill="${accent}"/><rect x="32" y="32" width="32" height="32" fill="${solid}"/></pattern></defs><rect width="256" height="256" fill="url(#${id})"/>`
    case 'stripes':
      return `<rect width="256" height="64" fill="${solid}"/><rect y="64" width="256" height="64" fill="${accent}"/><rect y="128" width="256" height="64" fill="${solid}"/><rect y="192" width="256" height="64" fill="${accent}"/>`
    case 'v-stripes':
      return `<rect width="64" height="256" fill="${solid}"/><rect x="64" width="64" height="256" fill="${accent}"/><rect x="128" width="64" height="256" fill="${solid}"/><rect x="192" width="64" height="256" fill="${accent}"/>`
    case 'quartered':
      return `<rect width="128" height="128" fill="${solid}"/><rect x="128" width="128" height="128" fill="${accent}"/><rect y="128" width="128" height="128" fill="${accent}"/><rect x="128" y="128" width="128" height="128" fill="${solid}"/>`
    case 'quartered-x':
      // Four triangles meeting at center. North/South wedges = accent, East/West wedges = solid.
      return `<rect width="256" height="256" fill="${solid}"/><polygon points="0,0 256,0 128,128" fill="${accent}"/><polygon points="0,256 256,256 128,128" fill="${accent}"/><polygon points="0,0 0,256 128,128" fill="${solid}"/><polygon points="256,0 256,256 128,128" fill="${solid}"/>`
    case 'dots': {
      let dots = ''
      for (let y = 32; y < 256; y += 64) {
        for (let x = 32; x < 256; x += 64) {
          dots += `<circle cx="${x}" cy="${y}" r="20" fill="${accent}"/>`
        }
      }
      return `<rect width="256" height="256" fill="${solid}"/>${dots}`
    }
    case 'big-dots': {
      let dots = ''
      for (let y = 64; y < 256; y += 128) {
        for (let x = 64; x < 256; x += 128) {
          dots += `<circle cx="${x}" cy="${y}" r="40" fill="${accent}"/>`
        }
      }
      return `<rect width="256" height="256" fill="${solid}"/>${dots}`
    }
  }
}

/**
 * Render or look up the cached PNG for the given badge inputs. Returns
 * an absolute path. Safe to call concurrently for the same inputs — the
 * file write is last-writer-wins on identical bytes.
 */
export async function renderAgentBadge(inputs: BadgeInputs): Promise<string> {
  mkdirSync(CACHE_DIR, { recursive: true })
  const key = cacheKey(inputs)
  const out = join(CACHE_DIR, key)
  if (existsSync(out)) return out

  if (process.env.DC_SKIP_PREBUILT !== '1') {
    const prebuilt = join(PREBUILT_DIR, key)
    if (existsSync(prebuilt)) {
      copyFileSync(prebuilt, out)
      return out
    }
  }

  const fallback = ARCHETYPE_DEFAULT_GLYPH[inputs.archetype]
  const inner = readGlyphInner(inputs.glyph, fallback)
  const palette = MODEL_COLORS[inputs.modelFamily]
  const svg = buildBadgeSvg(inner, palette.solid, palette.checker, inputs.pattern, inputs.trust)
  const png = new Resvg(svg).render().asPng()
  writeFileSync(out, png)
  return out
}
