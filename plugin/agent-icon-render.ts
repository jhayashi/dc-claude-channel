/**
 * Renders an agent avatar PNG from an emoji glyph on an archetype-colored
 * rounded background. Used by the agent-setup flow when the user sets an
 * explicit icon override — the glyph is rasterized to a PNG and installed
 * as the DC chat profile image.
 *
 * Color emoji rendering requires sharp's Pango-backed `text` input; plain
 * SVG <text> falls through librsvg's Cairo path which doesn't resolve
 * colr emoji fonts. We render the emoji via `text` and composite it on
 * top of an SVG-rendered rounded background.
 */

import sharp from 'sharp'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Archetype } from './agents.js'

const ARCHETYPE_BG: Record<Archetype, string> = {
  role: '#4a3b6e',      // indigo — personas
  utility: '#2e4158',   // slate — tools
  project: '#3f5a35',   // forest — projects
}

const ARCHETYPE_GLYPH: Record<Archetype, string> = {
  role: '\u{1F464}',         // 👤
  utility: '\u2699\uFE0F',   // ⚙️
  project: '\u{1F4CB}',      // 📋
}

function escapePango(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Render `glyph` centered on an archetype-colored rounded square. Returns
 * an absolute path to a temp PNG.
 */
export async function renderAgentIconPNG(
  glyph: string,
  archetype: Archetype = 'role',
): Promise<string> {
  const bg = ARCHETYPE_BG[archetype]
  const text = escapePango(glyph.trim() || ARCHETYPE_GLYPH[archetype])
  const bgSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">` +
      `<rect width="256" height="256" fill="${bg}" rx="40" ry="40"/></svg>`,
  )
  const emojiLayer = await sharp({
    text: {
      text: `<span font="140">${text}</span>`,
      rgba: true,
      width: 200,
      height: 200,
      align: 'center',
    },
  }).png().toBuffer()
  const out = await sharp(bgSvg)
    .composite([{ input: emojiLayer, gravity: 'center' }])
    .png()
    .toBuffer()
  const dir = mkdtempSync(join(tmpdir(), 'agent-icon-'))
  const path = join(dir, 'icon.png')
  writeFileSync(path, out)
  return path
}
