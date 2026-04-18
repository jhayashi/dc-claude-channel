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
const ICON_URI_MARKER = '/*__ICON_DATA_URI__*/'

export function getAgentSetupVersion(): number {
  return getAppVersion(HTML_PATH)
}

function buildInjectedHtml(): string {
  const html = readFileSync(HTML_PATH, 'utf-8')
  if (!html.includes(GLYPH_MARKER)) {
    throw new Error(`agent-setup.html is missing the ${GLYPH_MARKER} marker`)
  }
  if (!html.includes(ICON_URI_MARKER)) {
    throw new Error(`agent-setup.html is missing the ${ICON_URI_MARKER} marker`)
  }
  const glyphJson = JSON.stringify(loadGlyphsInnerXml())
  const iconBase64 = readFileSync(ICON_PATH).toString('base64')
  const iconDataUri = `data:image/png;base64,${iconBase64}`
  return html
    .replace(GLYPH_MARKER, glyphJson)
    .replace(ICON_URI_MARKER, iconDataUri)
}

export async function buildAgentSetupXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({
    htmlOverride: buildInjectedHtml(),
    manifestPath: MANIFEST_PATH,
    iconPath: ICON_PATH,
  })
}
