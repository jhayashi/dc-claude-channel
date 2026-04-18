/**
 * Agent setup WebXDC builder.
 *
 * Splices a compile-time Lucide glyph map into the HTML so the card can
 * render live badge previews client-side without a server round-trip.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'
import { loadGlyphsInnerXml } from './agent-setup-glyphs.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'agent-setup.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'agent-setup-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'agent-setup-icon.png')
const GLYPH_MARKER = '/*__GLYPHS__*/{}'

export function getAgentSetupVersion(): number {
  return getAppVersion(HTML_PATH)
}

function buildInjectedHtml(): string {
  const html = readFileSync(HTML_PATH, 'utf-8')
  if (!html.includes(GLYPH_MARKER)) {
    throw new Error(`agent-setup.html is missing the ${GLYPH_MARKER} marker`)
  }
  const glyphJson = JSON.stringify(loadGlyphsInnerXml())
  return html.replace(GLYPH_MARKER, glyphJson)
}

export async function buildAgentSetupXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({
    htmlOverride: buildInjectedHtml(),
    manifestPath: MANIFEST_PATH,
    iconPath: ICON_PATH,
  })
}
