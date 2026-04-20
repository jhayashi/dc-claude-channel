import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildXDC } from '../xdc-builder.js'

describe('buildXDC prebuilt fallback', () => {
  let tmp: string
  let htmlPath: string
  let manifestPath: string
  let prebuiltDir: string

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'xdc-test-'))
    htmlPath = join(tmp, 'app.html')
    manifestPath = join(tmp, 'manifest.toml')
    prebuiltDir = join(tmp, 'webxdc-prebuilt')
    mkdirSync(prebuiltDir)
    writeFileSync(htmlPath, '<html><script>var APP_VERSION = 3;</script></html>')
    writeFileSync(manifestPath, 'name = "Test App"\n')
  })

  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  test('returns pre-built .xdc when version matches', async () => {
    const marker = join(prebuiltDir, 'app-v3.xdc')
    writeFileSync(marker, 'SENTINEL')
    const { xdcPath } = await buildXDC({ htmlPath, manifestPath, prebuiltDir })
    expect(await Bun.file(xdcPath).text()).toBe('SENTINEL')
  })

  test('falls back to live build when prebuilt for version is missing', async () => {
    rmSync(join(prebuiltDir, 'app-v3.xdc'), { force: true })
    const { xdcPath, version } = await buildXDC({ htmlPath, manifestPath, prebuiltDir })
    expect(version).toBe(3)
    expect(await Bun.file(xdcPath).text()).not.toBe('SENTINEL')
  })

  test('DC_SKIP_PREBUILT=1 forces live build even when prebuilt exists', async () => {
    writeFileSync(join(prebuiltDir, 'app-v3.xdc'), 'SENTINEL')
    process.env.DC_SKIP_PREBUILT = '1'
    try {
      const { xdcPath } = await buildXDC({ htmlPath, manifestPath, prebuiltDir })
      expect(await Bun.file(xdcPath).text()).not.toBe('SENTINEL')
    } finally {
      delete process.env.DC_SKIP_PREBUILT
    }
  })

  test('htmlPath + htmlOverride: prebuilt lookup keys off htmlPath basename', async () => {
    // Simulates agent-setup.ts which splices glyphs/icon into HTML at build time
    // but still wants prebuilt-cache benefits. The splice never touches APP_VERSION,
    // so the prebuilt (built with the splice baked in) and the htmlPath's version
    // agree.
    writeFileSync(join(prebuiltDir, 'app-v3.xdc'), 'SENTINEL')
    const { xdcPath } = await buildXDC({
      htmlPath,
      htmlOverride: '<html><script>var APP_VERSION = 3;</script><!-- injected --></html>',
      manifestPath,
      prebuiltDir,
    })
    expect(await Bun.file(xdcPath).text()).toBe('SENTINEL')
  })

  test('htmlOverride without htmlPath: no prebuilt lookup, always live builds', async () => {
    writeFileSync(join(prebuiltDir, 'app-v3.xdc'), 'SENTINEL')
    const { xdcPath } = await buildXDC({
      htmlOverride: '<html><script>var APP_VERSION = 3;</script></html>',
      manifestPath,
      prebuiltDir,
    })
    expect(await Bun.file(xdcPath).text()).not.toBe('SENTINEL')
  })
})
