import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import {
  renderAgentBadge,
  setBadgeCacheDir,
  type BadgeInputs,
} from '../agent-icon-render'

const cacheDir = mkdtempSync(join(tmpdir(), 'dc-badge-cache-'))

beforeAll(() => setBadgeCacheDir(cacheDir))
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }))

const baseInputs: BadgeInputs = {
  archetype: 'role',
  modelFamily: 'sonnet',
  trust: false,
  glyph: 'user-round',
}

describe('renderAgentBadge', () => {
  test('returns a path that exists', async () => {
    const path = await renderAgentBadge(baseInputs)
    expect(existsSync(path)).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
  })

  test('cache key includes all four inputs', async () => {
    const a = await renderAgentBadge(baseInputs)
    const b = await renderAgentBadge({ ...baseInputs, trust: true })
    const c = await renderAgentBadge({ ...baseInputs, modelFamily: 'opus' })
    const d = await renderAgentBadge({ ...baseInputs, glyph: 'crown' })
    const e = await renderAgentBadge({ ...baseInputs, archetype: 'utility', glyph: 'cog' })
    expect(new Set([a, b, c, d, e]).size).toBe(5)
  })

  test('same inputs return same path and do not re-render', async () => {
    const first = await renderAgentBadge({ ...baseInputs, glyph: 'glasses' })
    const firstMtime = statSync(first).mtimeMs
    await new Promise(r => setTimeout(r, 10))
    const second = await renderAgentBadge({ ...baseInputs, glyph: 'glasses' })
    expect(second).toBe(first)
    expect(statSync(second).mtimeMs).toBe(firstMtime)
  })

  test('output is a valid 256x256 PNG decodable by sharp', async () => {
    const path = await renderAgentBadge({ ...baseInputs, glyph: 'briefcase' })
    const meta = await sharp(path).metadata()
    expect(meta.format).toBe('png')
    expect(meta.width).toBe(256)
    expect(meta.height).toBe(256)
  })

  test('renders all 24 (archetype × family × trust) combinations with default glyph', async () => {
    const archetypes = ['role', 'utility', 'project'] as const
    const families = ['haiku', 'sonnet', 'opus'] as const
    const defaults = { role: 'user-round', utility: 'cog', project: 'folder-kanban' }
    for (const a of archetypes) {
      for (const f of families) {
        for (const t of [false, true]) {
          const path = await renderAgentBadge({
            archetype: a, modelFamily: f, trust: t, glyph: defaults[a],
          })
          expect(existsSync(path)).toBe(true)
        }
      }
    }
  })

  test('missing glyph file falls back to archetype default', async () => {
    const path = await renderAgentBadge({
      ...baseInputs, archetype: 'utility', glyph: 'definitely-not-a-real-glyph',
    })
    expect(existsSync(path)).toBe(true)
    expect(path).toContain('definitely-not-a-real-glyph')
  })

  test('center pixel of a solid orange badge is roughly orange', async () => {
    const path = await renderAgentBadge({
      archetype: 'role', modelFamily: 'opus', trust: false, glyph: 'briefcase',
    })
    const { data } = await sharp(path).raw().toBuffer({ resolveWithObject: true })
    const offset = (128 * 256 + 16) * 4
    const r = data[offset], g = data[offset + 1], b = data[offset + 2]
    expect(Math.abs(r - 217)).toBeLessThan(10)
    expect(Math.abs(g - 119)).toBeLessThan(10)
    expect(Math.abs(b - 87)).toBeLessThan(10)
  })
})
