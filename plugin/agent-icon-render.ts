/**
 * Renders the per-agent chat profile image as a Technical Precision
 * badge: circular shell, hairline ring, paper-ink Lucide glyph centered
 * at 50%, on a model-colored background that is solid (default) or
 * two-tone same-hue checker (when the agent is "trusted" / skip-permissions).
 *
 * Outputs a 256x256 PNG and caches by deterministic key
 * `{archetype}-{family}-{trust}-{glyph}.png`. Same inputs reuse the
 * cached file; no re-render. Cache lives under $DC_STATE_DIR/agent-badges/
 * (or the dispatcher's default state dir).
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
} from './agent-icons/palettes.js'

export type { ModelFamily } from './agent-icons/palettes.js'

export interface BadgeInputs {
  archetype: Archetype
  modelFamily: ModelFamily
  trust: boolean
  glyph: string
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
  return `${i.archetype}-${i.modelFamily}-${trust}-${i.glyph}.png`
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

function buildBadgeSvg(inner: string, solid: string, checker: string | null): string {
  const defs = checker
    ? `<defs>
        <pattern id="check" patternUnits="userSpaceOnUse" width="128" height="128">
          <rect width="64" height="64" fill="${solid}"/>
          <rect x="64" width="64" height="64" fill="${checker}"/>
          <rect y="64" width="64" height="64" fill="${checker}"/>
          <rect x="64" y="64" width="64" height="64" fill="${solid}"/>
        </pattern>
        <clipPath id="circle"><circle cx="128" cy="128" r="128"/></clipPath>
      </defs>`
    : `<defs><clipPath id="circle"><circle cx="128" cy="128" r="128"/></clipPath></defs>`
  const fill = checker ? 'url(#check)' : solid
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
    ${defs}
    <g clip-path="url(#circle)">
      <rect width="256" height="256" fill="${fill}"/>
      <g transform="translate(64,64) scale(5.333)" stroke="#FAF9F5" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round">
        ${inner}
      </g>
    </g>
    <circle cx="128" cy="128" r="127.5" fill="none" stroke="rgba(11,15,23,0.12)" stroke-width="1"/>
  </svg>`
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
  const checker = inputs.trust ? palette.checker : null
  const svg = buildBadgeSvg(inner, palette.solid, checker)
  const png = new Resvg(svg).render().asPng()
  writeFileSync(out, png)
  return out
}
