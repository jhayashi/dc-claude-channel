/**
 * Slide Viewer WebXDC builder and tracker.
 *
 * Builds a .xdc ZIP containing the Marp-compatible slide viewer.
 * Tracks which chats already have a viewer instance so we
 * can reuse it via sendUpdate instead of sending a new .xdc.
 */

import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'slide-viewer.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'slide-viewer-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'slide-viewer-icon.png')

interface ViewerSession { msgId: number; lastUpdate?: string }
const activeViewers = new Map<number, ViewerSession>()

export function getViewer(chatId: number): number | null {
  return activeViewers.get(chatId)?.msgId ?? null
}

export function getSession(chatId: number): ViewerSession | null {
  return activeViewers.get(chatId) ?? null
}

export function setViewer(chatId: number, msgId: number): void {
  activeViewers.set(chatId, { msgId })
}

export function deleteViewer(chatId: number): void {
  activeViewers.delete(chatId)
}

export function viewerChatIds(): number[] {
  return [...activeViewers.keys()]
}

export function getViewerVersion(): number {
  return getAppVersion(HTML_PATH)
}

export async function buildViewerXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({ htmlPath: HTML_PATH, manifestPath: MANIFEST_PATH, iconPath: ICON_PATH })
}
