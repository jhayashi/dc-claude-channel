import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MODEL_COLORS } from '../agent-icons/palettes'

const HTML = readFileSync(
  join(import.meta.dir, '..', 'webxdc', 'agent-setup.html'),
  'utf-8',
)

function parsePalette(html: string): Record<string, { solid: string; checker: string }> {
  const block = html.match(/var\s+PREVIEW_PALETTE\s*=\s*\{([\s\S]*?)\};/)
  if (!block) throw new Error('PREVIEW_PALETTE literal not found in agent-setup.html')
  const entry = /([a-zA-Z_]\w*)\s*:\s*\{\s*solid\s*:\s*['"]([^'"]+)['"]\s*,\s*checker\s*:\s*['"]([^'"]+)['"]\s*\}/g
  const out: Record<string, { solid: string; checker: string }> = {}
  for (const m of block[1].matchAll(entry)) {
    out[m[1]] = { solid: m[2], checker: m[3] }
  }
  return out
}

test('PREVIEW_PALETTE in agent-setup.html matches MODEL_COLORS', () => {
  const preview = parsePalette(HTML)
  expect(Object.keys(preview).sort()).toEqual(Object.keys(MODEL_COLORS).sort())
  for (const key of Object.keys(MODEL_COLORS) as (keyof typeof MODEL_COLORS)[]) {
    expect(preview[key].solid.toLowerCase()).toBe(MODEL_COLORS[key].solid.toLowerCase())
    expect(preview[key].checker.toLowerCase()).toBe(MODEL_COLORS[key].checker.toLowerCase())
  }
})
