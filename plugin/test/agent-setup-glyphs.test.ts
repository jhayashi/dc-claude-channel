import { test, expect } from 'bun:test'
import { loadGlyphsInnerXml } from '../agent-setup-glyphs'

test('loadGlyphsInnerXml returns a map of glyph names to inner SVG strings', () => {
  const g = loadGlyphsInnerXml()
  expect(Object.keys(g).length).toBeGreaterThanOrEqual(20)
  expect(g['user-round']).toBeDefined()
  expect(g['user-round']).not.toContain('<svg')
  expect(g['user-round']).toMatch(/<(circle|path)/)
})
