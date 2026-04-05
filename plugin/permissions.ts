/**
 * Permissions WebXDC builder.
 */

import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'permission-prompt.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'permission-prompt-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'permissions-icon.png')

export function getPermissionsVersion(): number {
  return getAppVersion(HTML_PATH)
}

export async function buildPermissionsXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({ htmlPath: HTML_PATH, manifestPath: MANIFEST_PATH, iconPath: ICON_PATH })
}
