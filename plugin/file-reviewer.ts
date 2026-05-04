/**
 * File Reviewer WebXDC builder and tracker.
 *
 * Builds a .xdc ZIP containing the file reviewer app
 * (rendered markdown + syntax-highlighted source code).
 * Tracks which chats already have a viewer instance so we
 * can reuse it via sendUpdate instead of sending a new .xdc.
 *
 * Sessions are persisted to disk so reuse survives dispatcher
 * restarts — otherwise every restart ships a fresh applet card
 * on the next dc_send_file call.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildXDC, getAppVersion } from './xdc-builder.js'

const HTML_PATH = join(import.meta.dir, 'webxdc', 'file-reviewer.html')
const MANIFEST_PATH = join(import.meta.dir, 'webxdc', 'file-reviewer-manifest.toml')
const ICON_PATH = join(import.meta.dir, 'webxdc', 'file-reviewer-icon.png')
const PREBUILT_DIR = join(import.meta.dir, 'webxdc-prebuilt')

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

/** Record that a viewer was sent to a chat. Persists to disk. */
export function setViewer(chatId: number, msgId: number): void {
  activeViewers.set(chatId, { msgId })
  persistViewer(chatId)
}

/**
 * Update the lastUpdate replay payload for a chat and persist.
 * No-op if no session exists.
 */
export function setLastUpdate(chatId: number, update: string): void {
  const session = activeViewers.get(chatId)
  if (!session) return
  session.lastUpdate = update
  persistViewer(chatId)
}

/**
 * Clear the lastUpdate replay payload (e.g. after close_tab).
 * Persists the cleared state.
 */
export function clearLastUpdate(chatId: number): void {
  const session = activeViewers.get(chatId)
  if (!session) return
  session.lastUpdate = undefined
  persistViewer(chatId)
}

/** Remove a viewer session (e.g. on version mismatch). Removes disk copy too. */
export function deleteViewer(chatId: number): void {
  activeViewers.delete(chatId)
  deletePersistedViewer(chatId)
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
  return buildXDC({
    htmlPath: HTML_PATH,
    manifestPath: MANIFEST_PATH,
    iconPath: ICON_PATH,
    prebuiltDir: PREBUILT_DIR,
  })
}

// ---------------------------------------------------------------------------
// Persistence (survives dispatcher restarts)
// ---------------------------------------------------------------------------

let VIEWERS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'file-viewers')

/** Override the storage directory (for tests). */
export function setFileReviewersDir(dir: string): void {
  VIEWERS_DIR = dir
}

/** Return the current storage directory. */
export function getFileReviewersDir(): string {
  return VIEWERS_DIR
}

function viewerPath(chatId: number): string {
  return join(VIEWERS_DIR, `${chatId}.json`)
}

function persistViewer(chatId: number): void {
  const session = activeViewers.get(chatId)
  if (!session) return
  mkdirSync(VIEWERS_DIR, { recursive: true })
  const record = {
    chatId,
    msgId: session.msgId,
    lastUpdate: session.lastUpdate,
  }
  const finalPath = viewerPath(chatId)
  const tmpPath = `${finalPath}.tmp.${process.pid}.${crypto.randomUUID().slice(0, 8)}`
  writeFileSync(tmpPath, JSON.stringify(record, null, 2))
  renameSync(tmpPath, finalPath)
}

function deletePersistedViewer(chatId: number): void {
  const path = viewerPath(chatId)
  if (existsSync(path)) unlinkSync(path)
}

/**
 * Load all persisted viewer sessions into the in-memory map.
 * Invalid files are skipped. Called once at dispatcher startup.
 */
export function loadPersistedViewers(): { chatId: number; msgId: number }[] {
  if (!existsSync(VIEWERS_DIR)) return []
  const out: { chatId: number; msgId: number }[] = []
  for (const entry of readdirSync(VIEWERS_DIR)) {
    if (!entry.endsWith('.json')) continue
    try {
      const raw = JSON.parse(readFileSync(join(VIEWERS_DIR, entry), 'utf-8'))
      if (typeof raw.chatId === 'number' && typeof raw.msgId === 'number') {
        const session: ViewerSession = { msgId: raw.msgId }
        if (typeof raw.lastUpdate === 'string') session.lastUpdate = raw.lastUpdate
        activeViewers.set(raw.chatId, session)
        out.push({ chatId: raw.chatId, msgId: raw.msgId })
      }
    } catch {
      // skip invalid files
    }
  }
  return out
}

/** Clear in-memory state (for tests). */
export function _resetViewers(): void {
  activeViewers.clear()
}
