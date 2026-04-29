import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PNG } from 'pngjs'
import {
  renderAgentBadge,
  setBadgeCacheDir,
  type BadgeInputs,
} from '../agent-icon-render'

function decodePng(path: string): { width: number; height: number; data: Buffer } {
  return PNG.sync.read(readFileSync(path))
}

const cacheDir = mkdtempSync(join(tmpdir(), 'dc-badge-cache-'))

beforeAll(() => setBadgeCacheDir(cacheDir))
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }))

const baseInputs: BadgeInputs = {
  archetype: 'role',
  modelFamily: 'sonnet',
  trust: false,
  glyph: 'user-round',
  pattern: 'checker',
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

  test('output is a valid 256x256 PNG', async () => {
    const path = await renderAgentBadge({ ...baseInputs, glyph: 'briefcase' })
    const img = decodePng(path)
    expect(img.width).toBe(256)
    expect(img.height).toBe(256)
  })

  test('renders all 24 (archetype × family × trust) combinations with default glyph', async () => {
    const archetypes = ['role', 'utility', 'project'] as const
    const families = ['haiku', 'sonnet', 'opus'] as const
    const defaults = { role: 'user-round', utility: 'cog', project: 'folder-kanban' }
    for (const a of archetypes) {
      for (const f of families) {
        for (const t of [false, true]) {
          const path = await renderAgentBadge({
            archetype: a, modelFamily: f, trust: t, glyph: defaults[a], pattern: 'checker',
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

  test('prebuilt PNG is copied instead of re-rendered when available', async () => {
    // Drop a stub file into the real prebuilt dir under a key that could
    // not collide with a shipped build target. If the renderer's prebuilt
    // lookup works, the stub bytes flow through to the cache verbatim;
    // Resvg is never consulted (and would fall back to user-round anyway).
    const prebuiltDir = new URL('../agent-badges-prebuilt/', import.meta.url).pathname
    const { mkdirSync } = await import('node:fs')
    mkdirSync(prebuiltDir, { recursive: true })
    const stubKey = 'role-sonnet-plain-test-stub-glyph-checker.png'
    const stubPath = join(prebuiltDir, stubKey)
    const stubBytes = Buffer.from('STUBBED-BADGE-CONTENT')
    writeFileSync(stubPath, stubBytes)
    try {
      const out = await renderAgentBadge({
        archetype: 'role', modelFamily: 'sonnet', trust: false, glyph: 'test-stub-glyph', pattern: 'checker',
      })
      expect(readFileSync(out).equals(stubBytes)).toBe(true)
    } finally {
      rmSync(stubPath, { force: true })
    }
  })

  test('DC_SKIP_PREBUILT=1 bypasses prebuilt lookup', async () => {
    const prebuiltDir = new URL('../agent-badges-prebuilt/', import.meta.url).pathname
    const { mkdirSync } = await import('node:fs')
    mkdirSync(prebuiltDir, { recursive: true })
    const stubKey = 'role-sonnet-plain-test-stub-glyph-2-checker.png'
    const stubPath = join(prebuiltDir, stubKey)
    writeFileSync(stubPath, Buffer.from('STUBBED-BADGE-CONTENT-2'))
    const prior = process.env.DC_SKIP_PREBUILT
    process.env.DC_SKIP_PREBUILT = '1'
    try {
      const out = await renderAgentBadge({
        archetype: 'role', modelFamily: 'sonnet', trust: false, glyph: 'test-stub-glyph-2', pattern: 'checker',
      })
      // With skip set, Resvg renders fresh; bytes do not match the stub.
      expect(readFileSync(out).equals(Buffer.from('STUBBED-BADGE-CONTENT-2'))).toBe(false)
      const img = decodePng(out)
      expect(img.width).toBe(256)
    } finally {
      if (prior === undefined) delete process.env.DC_SKIP_PREBUILT
      else process.env.DC_SKIP_PREBUILT = prior
      rmSync(stubPath, { force: true })
    }
  })

  test('center pixel of a solid orange badge is roughly orange', async () => {
    const path = await renderAgentBadge({
      archetype: 'role', modelFamily: 'opus', trust: false, glyph: 'briefcase', pattern: 'checker',
    })
    const { data } = decodePng(path)
    const offset = (128 * 256 + 16) * 4
    const r = data[offset], g = data[offset + 1], b = data[offset + 2]
    expect(Math.abs(r - 217)).toBeLessThan(10)
    expect(Math.abs(g - 119)).toBeLessThan(10)
    expect(Math.abs(b - 87)).toBeLessThan(10)
  })
})
