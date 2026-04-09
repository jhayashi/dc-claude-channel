/**
 * Agent setup WebXDC builder.
 */

import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'group-setup.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'group-setup-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'group-setup-icon.png')

export function getGroupSetupVersion(): number {
  return getAppVersion(HTML_PATH)
}

export async function buildGroupSetupXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({ htmlPath: HTML_PATH, manifestPath: MANIFEST_PATH, iconPath: ICON_PATH })
}
