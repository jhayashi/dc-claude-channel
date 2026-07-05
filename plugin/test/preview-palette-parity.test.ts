import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_COLORS, UNKNOWN_MODEL_COLOR } from '../agent-icons/palettes'

// The agent-setup monolith was retired in increment 4 (#109); its live
// badge preview lives on in the two successor cards that carry a model
// picker — create-agent (new agent) and agent-manage (edit form). Both
// embed a PREVIEW_PALETTE literal that MUST mirror the server-side
// MODEL_COLORS so the badge a user sees while editing matches the badge
// that renders server-side.
const HTML_FILES = ['create-agent.html', 'agent-manage.html'] as const

function parsePalette(html: string, source: string): Record<string, { solid: string; checker: string }> {
  const block = html.match(/var\s+PREVIEW_PALETTE\s*=\s*\{([\s\S]*?)\};/)
  if (!block) throw new Error(`PREVIEW_PALETTE literal not found in ${source}`)
  const entry = /([a-zA-Z_]\w*)\s*:\s*\{\s*solid\s*:\s*['"]([^'"]+)['"]\s*,\s*checker\s*:\s*['"]([^'"]+)['"]\s*\}/g
  const out: Record<string, { solid: string; checker: string }> = {}
  for (const m of block[1].matchAll(entry)) {
    out[m[1]] = { solid: m[2], checker: m[3] }
  }
  return out
}

// v1.4.11+ — PREVIEW_PALETTE in each card must mirror MODEL_COLORS *plus*
// an "unknown" entry that maps to UNKNOWN_MODEL_COLOR. The "unknown" entry
// is what the live-preview falls back to when the user is on the "Other…"
// segment (typing a custom model ID whose tier doesn't have a curated
// color). Adding a tier to MODEL_COLORS without adding it to
// PREVIEW_PALETTE — or vice versa — breaks the preview-vs-server-render
// invariant (the badge user sees while editing must match the badge that
// renders server-side).
for (const file of HTML_FILES) {
  test(`PREVIEW_PALETTE in ${file} matches MODEL_COLORS + the unknown fallback`, () => {
    const html = readFileSync(join(import.meta.dir, '..', 'webxdc', file), 'utf-8')
    const preview = parsePalette(html, file)
    const expectedKeys = [...Object.keys(MODEL_COLORS), 'unknown'].sort()
    expect(Object.keys(preview).sort()).toEqual(expectedKeys)
    for (const key of Object.keys(MODEL_COLORS) as (keyof typeof MODEL_COLORS)[]) {
      expect(preview[key].solid.toLowerCase()).toBe(MODEL_COLORS[key].solid.toLowerCase())
      expect(preview[key].checker.toLowerCase()).toBe(MODEL_COLORS[key].checker.toLowerCase())
    }
    expect(preview.unknown.solid.toLowerCase()).toBe(UNKNOWN_MODEL_COLOR.solid.toLowerCase())
    expect(preview.unknown.checker.toLowerCase()).toBe(UNKNOWN_MODEL_COLOR.checker.toLowerCase())
  })
}
