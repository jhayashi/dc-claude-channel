/**
 * Compile-time loader for Lucide glyph SVG bodies.
 *
 * The agent-setup WebXDC needs the raw inner SVG of each glyph so it can
 * render live badge previews client-side without a server round-trip. We
 * inject the map into the HTML at build time (see agent-setup.ts).
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const GLYPHS_DIR = join(import.meta.dir, 'agent-icons', 'glyphs')
const SVG_BODY_RE = /<svg[^>]*>([\s\S]*)<\/svg>/

function extractInner(svg: string): string {
  const m = svg.match(SVG_BODY_RE)
  if (!m) throw new Error('agent-setup-glyphs: not a valid SVG')
  return m[1].trim()
}

export function loadGlyphsInnerXml(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of readdirSync(GLYPHS_DIR)) {
    if (!f.endsWith('.svg')) continue
    const name = f.slice(0, -4)
    out[name] = extractInner(readFileSync(join(GLYPHS_DIR, f), 'utf-8'))
  }
  return out
}
