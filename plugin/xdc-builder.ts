/**
 * Shared WebXDC builder.
 *
 * Reads HTML, manifest, and icon fresh from disk on each build so
 * changes take effect without restarting the server.
 *
 * All server-coupled WebXDC apps MUST have:
 *   - A manifest.toml file with `name = "My App"`
 *   - `var APP_VERSION = <number>;` in their HTML
 *
 * The builder appends the version to the manifest name automatically.
 */

import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { zipSync, strToU8 } from 'fflate'

export interface XDCAppConfig {
  /** Path to the HTML file */
  htmlPath: string
  /** Path to the manifest.toml file */
  manifestPath: string
  /** Path to the icon PNG file (optional) */
  iconPath?: string
}

/** Parse APP_VERSION from an HTML file. Throws if not found. */
export function getAppVersion(htmlPath: string): number {
  const html = readFileSync(htmlPath, 'utf-8')
  const m = html.match(/var\s+APP_VERSION\s*=\s*([\d.]+)/)
  if (!m) {
    throw new Error(
      `APP_VERSION not found in ${htmlPath}. ` +
      `All server-coupled WebXDC apps must include 'var APP_VERSION = <number>;' in their script. ` +
      `This is required for the auto-upgrade protocol.`
    )
  }
  return Number(m[1])
}

/**
 * Build a .xdc ZIP from HTML + manifest + optional icon.
 * Reads all files fresh from disk (not cached).
 * Appends version to the manifest name.
 * Returns the path to the temp .xdc file and the version.
 */
export async function buildXDC(config: XDCAppConfig): Promise<{ xdcPath: string; version: number }> {
  const { htmlPath, manifestPath, iconPath } = config

  const version = getAppVersion(htmlPath)
  const html = readFileSync(htmlPath)

  // Read manifest and append version to the name
  const rawManifest = readFileSync(manifestPath, 'utf-8')
  const manifest = rawManifest.replace(
    /^(name\s*=\s*"[^"]+)(")/m,
    `$1 v${version}$2`,
  )

  // Extract name for the .xdc filename
  const nameMatch = rawManifest.match(/^name\s*=\s*"([^"]+)"/m)
  const name = nameMatch ? nameMatch[1] : 'app'

  const dir = mkdtempSync(join(tmpdir(), 'claude-dc-xdc-'))
  const xdcPath = join(dir, `${name.toLowerCase().replace(/[^\x20-\x7e]+/g, '').trim().replace(/\s+/g, '-')}.xdc`)

  const files: Record<string, Uint8Array> = {
    'index.html': html instanceof Uint8Array ? html : new Uint8Array(html.buffer, html.byteOffset, html.byteLength),
    'manifest.toml': strToU8(manifest),
  }

  if (iconPath && existsSync(iconPath)) {
    const icon = readFileSync(iconPath)
    files['icon.png'] = new Uint8Array(icon.buffer, icon.byteOffset, icon.byteLength)
  }

  const zipped = zipSync(files)
  writeFileSync(xdcPath, zipped)

  return { xdcPath, version }
}
