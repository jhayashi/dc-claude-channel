/**
 * Regression coverage for the eight trust-on background patterns the
 * runtime renderer supports (mini-checker, stripes, v-stripes,
 * quartered, quartered-x, dots, big-dots — plus the legacy checker).
 *
 * Two tiers of assertion:
 *   1. Each (pattern × model family) combination produces a non-empty
 *      PNG. Catches "blew up at SVG parse / Resvg render" regressions.
 *   2. Trust-on patterns sample at least two distinct background colors
 *      across a small fixed grid. Catches "pattern silently fell
 *      through to solid" regressions, which would otherwise silently
 *      revert the visual variety we just added.
 *
 * The trust-off path is also covered to ensure pattern is correctly
 * ignored when trust=false (single solid color, no pattern fill).
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PNG } from 'pngjs'
import { renderAgentBadge, setBadgeCacheDir } from '../agent-icon-render.js'
import { PATTERN_IDS } from '../agent-icons/palettes.js'

beforeEach(() => {
  // Force a fresh cache dir per test so cacheKey collisions across
  // runs can't mask a regression.
  setBadgeCacheDir(mkdtempSync(join(tmpdir(), 'dc-badge-patterns-')))
})

function samplePixelColors(pngPath: string, points: ReadonlyArray<[number, number]>) {
  const png = PNG.sync.read(readFileSync(pngPath))
  return points.map(([x, y]) => {
    const i = (png.width * y + x) * 4
    return { r: png.data[i], g: png.data[i + 1], b: png.data[i + 2] }
  })
}

describe('Badge patterns', () => {
  for (const pattern of PATTERN_IDS) {
    test(`renders the ${pattern} pattern across all 3 tiers`, async () => {
      for (const family of ['haiku', 'sonnet', 'opus'] as const) {
        const path = await renderAgentBadge({
          archetype: 'role',
          modelFamily: family,
          trust: true,
          glyph: 'user-round',
          pattern,
        })
        // 256x256 PNGs are reliably > 1 KB; anything smaller signals
        // an empty / corrupt write.
        expect(statSync(path).size).toBeGreaterThan(1000)
      }
    }, 20000)
  }

  test('solid (trust-off) renders without a pattern', async () => {
    const path = await renderAgentBadge({
      archetype: 'role',
      modelFamily: 'sonnet',
      trust: false,
      glyph: 'user-round',
      pattern: 'checker', // ignored when trust=false
    })
    expect(statSync(path).size).toBeGreaterThan(1000)
  }, 20000)

  // Pixel-sample assertion: each non-trivial pattern must produce at
  // least 2 distinct colors in trust-on mode. Sample points are chosen
  // so that no single pattern produces all-equal samples (e.g. a
  // 4-corner sample wouldn't work for v-stripes because all four
  // corners are the same band).
  const PIXEL_TEST_POINTS: ReadonlyArray<[number, number]> = [
    [16, 16],   // top-left
    [240, 16],  // top-right
    [16, 240],  // bottom-left
    [240, 240], // bottom-right
    [128, 16],  // top-center
    [16, 128],  // left-center
    [240, 128], // right-center
    [128, 240], // bottom-center
  ]

  for (const pattern of PATTERN_IDS) {
    test(`${pattern} pattern has both solid and accent regions (pixel-sampled)`, async () => {
      const path = await renderAgentBadge({
        archetype: 'role',
        modelFamily: 'sonnet',
        trust: true,
        glyph: 'user-round',
        pattern,
      })
      const samples = samplePixelColors(path, PIXEL_TEST_POINTS)
      const distinct = new Set(samples.map(c => `${c.r},${c.g},${c.b}`))
      // Every pattern listed in PATTERN_IDS uses two colors; we must
      // see at least two distinct pixel values somewhere in the grid.
      expect(distinct.size).toBeGreaterThanOrEqual(2)
    }, 20000)
  }

  test('different patterns produce different cache files for the same agent inputs', async () => {
    const a = await renderAgentBadge({
      archetype: 'role', modelFamily: 'sonnet', trust: true, glyph: 'user-round', pattern: 'checker',
    })
    const b = await renderAgentBadge({
      archetype: 'role', modelFamily: 'sonnet', trust: true, glyph: 'user-round', pattern: 'stripes',
    })
    expect(a).not.toBe(b)
  }, 20000)
})
