/** Teleport WebXDC builder. Mirrors the other thin card build modules. */
import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'teleport.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'teleport-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'teleport-icon.png')
const PREBUILT_DIR = join(import.meta.dir, 'webxdc-prebuilt')

export function getTeleportVersion(): number {
  return getAppVersion(HTML_PATH)
}

export async function buildTeleportXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({
    htmlPath: HTML_PATH,
    manifestPath: MANIFEST_PATH,
    iconPath: ICON_PATH,
    prebuiltDir: PREBUILT_DIR,
  })
}
