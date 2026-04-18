import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync, strFromU8 } from 'fflate'
import { buildXDC } from '../xdc-builder'

const manifestPath = join(import.meta.dir, 'fixtures', 'manifest.toml')
const iconPath = join(import.meta.dir, 'fixtures', 'icon.png')

test('buildXDC htmlOverride replaces htmlPath content in the zip', async () => {
  const override = '<html><body><script>var APP_VERSION = 9.99;</script><h1>OVERRIDE-MARKER</h1></body></html>'
  const { xdcPath, version } = await buildXDC({ htmlOverride: override, manifestPath, iconPath })
  const entries = unzipSync(readFileSync(xdcPath))
  expect(strFromU8(entries['index.html'])).toContain('OVERRIDE-MARKER')
  expect(version).toBe(9.99)
})
