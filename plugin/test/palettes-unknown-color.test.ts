import { test, expect } from 'bun:test'
import { MODEL_COLORS, UNKNOWN_MODEL_COLOR } from '../agent-icons/palettes'

// v1.4.11 — adding a tier to MODEL_COLORS is optional. The renderer
// falls back to UNKNOWN_MODEL_COLOR (Zinc-700 solid / Zinc-600 checker)
// for any tier the manifest doesn't register. These tests pin the
// fallback color, the opaque-string lookup shape, and the absence of
// drift for the three registered tiers.

test('UNKNOWN_MODEL_COLOR is exported with Zinc-grey palette', () => {
  expect(UNKNOWN_MODEL_COLOR).toEqual({ solid: '#3F3F46', checker: '#52525B' })
})

test('MODEL_COLORS keyed by string returns undefined for truly unregistered tiers', () => {
  expect(MODEL_COLORS['zephyr']).toBeUndefined()
  expect(MODEL_COLORS['mythos']).toBeUndefined()
  expect(MODEL_COLORS['unknown']).toBeUndefined()
  expect(MODEL_COLORS['opus']).toBeDefined()
})

test('MODEL_COLORS preserves the three original tier palettes', () => {
  expect(MODEL_COLORS['haiku']).toEqual({ solid: '#B4862A', checker: '#D9B25B' })
  expect(MODEL_COLORS['sonnet']).toEqual({ solid: '#3DA85A', checker: '#65C081' })
  expect(MODEL_COLORS['opus']).toEqual({ solid: '#D97757', checker: '#F2A778' })
})

// v1.4.12 — Fable becomes an officially-supported tier with a curated
// deep-purple palette. Solid Violet-700 / checker Violet-400 follows
// the same dark-solid + lighter-same-hue pattern as the existing tier
// colors (haiku amber-pair, sonnet green-pair, opus orange-pair).
test('MODEL_COLORS["fable"] is Violet-700 / Violet-400 (v1.4.12)', () => {
  expect(MODEL_COLORS['fable']).toEqual({ solid: '#6D28D9', checker: '#A78BFA' })
})
