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

import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
  const contentDir = join(dir, 'content')
  mkdirSync(contentDir)
  writeFileSync(join(contentDir, 'index.html'), html)
  writeFileSync(join(contentDir, 'manifest.toml'), manifest)

  const zipArgs = [
    'zip', '-j', xdcPath,
    join(contentDir, 'index.html'),
    join(contentDir, 'manifest.toml'),
  ]

  if (iconPath && existsSync(iconPath)) {
    const icon = readFileSync(iconPath)
    writeFileSync(join(contentDir, 'icon.png'), icon)
    zipArgs.push(join(contentDir, 'icon.png'))
  }

  const result = Bun.spawnSync(zipArgs)
  if (result.exitCode !== 0) {
    throw new Error(`zip failed for ${name}: ${result.stderr.toString()}`)
  }

  return { xdcPath, version }
}
