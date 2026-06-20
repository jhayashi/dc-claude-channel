/**
 * Pre-build every server-coupled WebXDC app into `plugin/webxdc-prebuilt/`
 * so the dispatcher can skip the live zip step at send time. Runtime
 * lookup is in xdc-builder.ts; this script is release-time only.
 *
 * Run via `bun run build:xdcs` in `plugin/`.
 */

import { buildPermissionsXDC } from '../permissions.js'
import { buildViewerXDC } from '../file-reviewer.js'
import { buildAgentSetupXDC } from '../agent-setup.js'
import { buildTeleportXDC } from '../teleport.js'
import { mkdirSync, copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const OUT = join(import.meta.dir, '..', 'webxdc-prebuilt')
mkdirSync(OUT, { recursive: true })

const targets = [
  { id: 'permission-prompt', build: buildPermissionsXDC },
  { id: 'file-reviewer', build: buildViewerXDC },
  { id: 'agent-setup', build: buildAgentSetupXDC },
  { id: 'teleport', build: buildTeleportXDC },
]

for (const t of targets) {
  const { xdcPath, version } = await t.build()
  const dest = join(OUT, `${t.id}-v${version}.xdc`)
  copyFileSync(xdcPath, dest)
  unlinkSync(xdcPath)
  console.log(`built ${dest}`)
}
