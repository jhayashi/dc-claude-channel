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
  /** Path to the HTML file. When both this and `htmlOverride` are set,
   *  `htmlOverride` supplies the live-build HTML while `htmlPath` is
   *  still used to derive the prebuilt-lookup key and to probe
   *  `APP_VERSION` on disk. */
  htmlPath?: string
  /** Inline HTML string or thunk. When set, used in place of reading
   *  `htmlPath` for the live build. A thunk lets callers defer expensive
   *  HTML construction (e.g. agent-setup's glyph/icon splice) until
   *  after the prebuilt lookup misses. Does NOT disable prebuilt lookup
   *  on its own — callers that want prebuilt + splice should pass both
   *  `htmlPath` and `htmlOverride`. */
  htmlOverride?: string | (() => string)
  /** Path to the manifest.toml file */
  manifestPath: string
  /** Path to the icon PNG file (optional) */
  iconPath?: string
  /** Directory containing pre-built `.xdc` files named
   *  `<html-basename>-v<version>.xdc`. If present, a matching file
   *  exists, and `DC_SKIP_PREBUILT` is not `1`, the cached file is
   *  returned instead of running the live zip. Requires `htmlPath`
   *  (to compute the lookup key); ignored otherwise. */
  prebuiltDir?: string
}

function parseAppVersion(html: string, source: string): number {
  const m = html.match(/var\s+APP_VERSION\s*=\s*([\d.]+)/)
  if (!m) {
    throw new Error(
      `APP_VERSION not found in ${source}. ` +
      `All server-coupled WebXDC apps must include 'var APP_VERSION = <number>;' in their script. ` +
      `This is required for the auto-upgrade protocol.`
    )
  }
  return Number(m[1])
}

/** Parse APP_VERSION from an HTML file. Throws if not found. */
export function getAppVersion(htmlPath: string): number {
  return parseAppVersion(readFileSync(htmlPath, 'utf-8'), htmlPath)
}

/**
 * Build a .xdc ZIP from HTML + manifest + optional icon.
 * Reads all files fresh from disk (not cached).
 * Appends version to the manifest name.
 * Returns the path to the temp .xdc file and the version.
 */
export async function buildXDC(config: XDCAppConfig): Promise<{ xdcPath: string; version: number }> {
  const { htmlPath, htmlOverride, manifestPath, iconPath, prebuiltDir } = config

  if (!htmlOverride && !htmlPath) {
    throw new Error('buildXDC: one of htmlPath or htmlOverride is required')
  }

  // Determine version cheaply: if htmlPath is available, read it directly
  // (cheap disk read) rather than resolving a potentially-expensive
  // htmlOverride thunk. Callers that pass both (e.g. agent-setup) are
  // asserting the override's APP_VERSION matches htmlPath's.
  let version: number
  if (htmlPath) {
    version = parseAppVersion(readFileSync(htmlPath, 'utf-8'), htmlPath)
  } else {
    const resolved = typeof htmlOverride === 'function' ? htmlOverride() : htmlOverride!
    version = parseAppVersion(resolved, '<htmlOverride>')
  }

  // Prefer pre-built if available, version matches, and DC_SKIP_PREBUILT isn't set.
  // Requires htmlPath (for the lookup key); htmlOverride alone can't key the cache
  // since its origin is an in-memory string.
  if (prebuiltDir && htmlPath && process.env.DC_SKIP_PREBUILT !== '1') {
    const id = htmlPath.split('/').pop()!.replace(/\.html$/, '')
    const prebuilt = join(prebuiltDir, `${id}-v${version}.xdc`)
    if (existsSync(prebuilt)) {
      const dir = mkdtempSync(join(tmpdir(), 'claude-dc-xdc-prebuilt-'))
      const dest = join(dir, `${id}.xdc`)
      await Bun.write(dest, Bun.file(prebuilt))
      return { xdcPath: dest, version }
    }
  }

  // Live-build path: now resolve the override (may run the splice).
  const htmlText = htmlOverride !== undefined
    ? (typeof htmlOverride === 'function' ? htmlOverride() : htmlOverride)
    : readFileSync(htmlPath!, 'utf-8')
  const html = Buffer.from(htmlText, 'utf-8')

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
