/**
 * Help card WebXDC builder (#108). Mirrors the other thin card build
 * modules, with one twist: the content is injected at BUILD time — the
 * card is fully static (no init payload, zero server round-trips), so it
 * renders even when the dispatcher's session map is confused, which is
 * exactly when people open help.
 *
 * Content source: help-content.ts (typed topics/journeys; the Commands
 * topic is generated from slash-commands.ts). Changing content requires
 * an APP_VERSION bump in help.html — the prebuilt is keyed by version.
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { buildXDC, getAppVersion } from './xdc-builder.js'
import { HELP_TOPICS } from './help-content.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'help.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'help-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'help-icon.png')
const PREBUILT_DIR = join(import.meta.dir, 'webxdc-prebuilt')

const CONTENT_MARKER = '__HELP_CONTENT__'

export function getHelpVersion(): number {
  return getAppVersion(HTML_PATH)
}

/** Read help.html and splice the content JSON at the marker. Exported for tests. */
export function renderHelpHtml(): string {
  const html = readFileSync(HTML_PATH, 'utf-8')
  if (!html.includes(CONTENT_MARKER)) {
    throw new Error(`help.html is missing the ${CONTENT_MARKER} marker`)
  }
  // JSON is safe in a <script> context here: the content lint forbids
  // '</script' sequences in the serialized payload.
  return html.replace(CONTENT_MARKER, JSON.stringify(HELP_TOPICS))
}

export async function buildHelpXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({
    htmlPath: HTML_PATH,
    htmlOverride: () => renderHelpHtml(),
    manifestPath: MANIFEST_PATH,
    iconPath: ICON_PATH,
    prebuiltDir: PREBUILT_DIR,
  })
}
