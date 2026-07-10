/**
 * Agent-definition attachment import (#130 / #137), extracted from a
 * server.ts closure so the intercept contract is unit-testable.
 *
 * Accepts:
 *  - `.yaml` / `.yml` attachments (the legacy manage-card export names) —
 *    any parse failure surfaces an error toast, since a .yaml dropped in
 *    chat is overwhelmingly an import attempt;
 *  - `.md` attachments (the documented terminal-CC flow: share a
 *    `~/.claude/agents/<name>.md`) — but ONLY when the file sniffs as an
 *    agent definition (frontmatter with a `name` or `model` key).
 *    Ordinary markdown documents are common chat traffic and must pass
 *    through silently, never swallowed or error-toasted.
 *
 * Returns true when the message was fully handled (imported, or refused
 * with a user-visible message); false when it should fall through to the
 * subagent as ordinary conversation context.
 */

import { readFileSync, statSync } from 'node:fs'
import * as agents from '../agents.js'
import { parseAgentMarkdown } from '../agent-md.js'

export interface AgentImportDeps {
  send(chatId: number, text: string): Promise<unknown>
  logf(fmt: string, ...args: unknown[]): void
}

export interface AgentImportMsg {
  chatId: number
  file?: string
  fileName?: string
  fileBytes?: number
}

const MAX_IMPORT_BYTES = 256 * 1024

/** Does this parsed frontmatter look like an agent definition? */
function looksLikeAgentFrontmatter(frontmatter: Record<string, unknown>): boolean {
  return typeof frontmatter.name === 'string' || typeof frontmatter.model === 'string'
}

export async function tryImportAgentAttachment(
  deps: AgentImportDeps,
  msg: AgentImportMsg,
): Promise<boolean> {
  if (!msg.file || !msg.fileName) return false
  const lower = msg.fileName.toLowerCase()
  const isYaml = lower.endsWith('.yaml') || lower.endsWith('.yml')
  const isMd = lower.endsWith('.md')
  if (!isYaml && !isMd) return false

  const chatId = msg.chatId

  try {
    // statSync fallback because msg.fileBytes may be undefined/0 on some
    // DC clients (same pattern as tryImportFamiliarAttachment).
    const actualSize = msg.fileBytes || statSync(msg.file).size
    if (actualSize > MAX_IMPORT_BYTES) {
      // A .md over the cap could be an ordinary document — only toast for
      // the explicit .yaml import extension; oversized .md just falls
      // through unless it sniffs as an agent below (it won't be read).
      if (isYaml) {
        await deps.send(chatId, '⚠️ Agent import failed: file too large (max 256 KB).')
        return true
      }
    }

    const text = readFileSync(msg.file, 'utf-8')

    if (isMd) {
      // Sniff before committing: ordinary markdown passes through with no
      // toast. Only frontmatter carrying agent-shaped keys proceeds.
      if (!text.startsWith('---')) return false
      let frontmatter: Record<string, unknown>
      try {
        frontmatter = parseAgentMarkdown(text).frontmatter
      } catch {
        return false
      }
      if (!looksLikeAgentFrontmatter(frontmatter)) return false
    }

    if (text.length > MAX_IMPORT_BYTES) {
      await deps.send(chatId, '⚠️ Agent import failed: file too large (max 256 KB).')
      return true
    }

    const result = agents.importAgentFromMarkdown(text)
    const idNote = result.nameChanged ? ` (saved as "${result.agent.name}" to avoid a name conflict)` : ''
    const display = result.agent['x-dc-display-name'] ?? result.agent.name
    await deps.send(
      chatId,
      `✅ Imported agent "${result.agent.name}"${idNote}. ` +
      `Say "use ${display} in this chat" to switch a chat to it, or "show me my agents" to manage it.`,
    )
    deps.logf('import: agent "%s" imported from attachment in chat %d', result.agent.name, chatId)
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Truncate long Zod errors to keep the DC message short.
    const short = message.length > 200 ? message.slice(0, 200) + '...' : message
    await deps.send(chatId, `⚠️ Couldn't import agent from "${msg.fileName}": ${short}`)
    deps.logf('import: failed for chat %d file=%s: %v', chatId, msg.fileName, err)
    // Return false so the message still reaches the subagent — the user
    // may have sent the file as context for a conversation.
    return false
  }
}
