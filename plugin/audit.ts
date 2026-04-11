/**
 * Per-chat audit log. When a bound agent has the skipPermissions flag
 * enabled, the dispatcher appends an entry here for every tool call it
 * auto-approved so the user can review after the fact instead of
 * approving in real time.
 *
 * Layout: ~/.claude/channels/deltachat/audit/<chatId>.md — one
 * markdown file per chat, append-only. The file-reviewer WebXDC app
 * renders it directly via the dc_show_audit tool.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let AUDIT_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'audit')

/** Override the audit directory (for tests). */
export function setAuditDir(dir: string): void {
  AUDIT_DIR = dir
}

export interface AuditEntry {
  chatId: number
  agentId: string
  tool: string
  input: unknown
  timestamp: string // ISO 8601
}

const MAX_INPUT_CHARS = 1000

/** Absolute path to a chat's audit file (whether or not it exists). */
export function auditFilePath(chatId: number): string {
  return join(AUDIT_DIR, `${chatId}.md`)
}

/** Path if the file exists, else null. */
export function auditFilePathIfExists(chatId: number): string | null {
  const p = auditFilePath(chatId)
  return existsSync(p) ? p : null
}

/**
 * Append one auto-approved tool call to the chat's audit file. Creates
 * the audit directory and file on first call. Long inputs are truncated
 * with an ellipsis.
 */
export function appendEntry(entry: AuditEntry): void {
  mkdirSync(AUDIT_DIR, { recursive: true })
  const path = auditFilePath(entry.chatId)
  const header = existsSync(path)
    ? ''
    : `# Audit log for chat ${entry.chatId}\n\nAuto-approved tool calls for agents running in skip-permissions mode.\n\n`
  appendFileSync(path, header + renderEntry(entry))
}

function renderEntry(entry: AuditEntry): string {
  const raw = JSON.stringify(entry.input ?? {})
  const truncated =
    raw.length > MAX_INPUT_CHARS ? `${raw.slice(0, MAX_INPUT_CHARS)}…` : raw
  return (
    `## ${entry.timestamp} — \`${entry.tool}\`\n` +
    `_agent: ${entry.agentId}_\n\n` +
    '```json\n' +
    truncated +
    '\n```\n\n'
  )
}
