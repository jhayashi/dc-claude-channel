/**
 * File Reviewer WebXDC builder and tracker.
 *
 * Builds a .xdc ZIP containing the file reviewer app
 * (rendered markdown + syntax-highlighted source code).
 * Tracks which chats already have a viewer instance so we
 * can reuse it via sendUpdate instead of sending a new .xdc.
 */

import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'markdown-viewer.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'markdown-viewer-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'markdown-viewer-icon.png')

// Track which chat has an active viewer session.
interface ViewerSession { msgId: number; lastUpdate?: string }
const activeViewers = new Map<number, ViewerSession>()

/** Get the viewer message ID for a chat, or null if none sent yet. */
export function getViewer(chatId: number): number | null {
  return activeViewers.get(chatId)?.msgId ?? null
}

/** Get the full session for a chat. */
export function getSession(chatId: number): ViewerSession | null {
  return activeViewers.get(chatId) ?? null
}

/** Record that a viewer was sent to a chat. */
export function setViewer(chatId: number, msgId: number): void {
  activeViewers.set(chatId, { msgId })
}

/** Remove a viewer session (e.g. on version mismatch). */
export function deleteViewer(chatId: number): void {
  activeViewers.delete(chatId)
}

/** All chat IDs with active viewers. */
export function viewerChatIds(): number[] {
  return [...activeViewers.keys()]
}

export function getViewerVersion(): number {
  return getAppVersion(HTML_PATH)
}

/** Build the file-reviewer.xdc file. Returns {xdcPath, version}. */
export async function buildViewerXDC(): Promise<{ xdcPath: string; version: number }> {
  return buildXDC({ htmlPath: HTML_PATH, manifestPath: MANIFEST_PATH, iconPath: ICON_PATH })
}
