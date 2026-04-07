import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as fileReviewer from '../file-reviewer.js'

const MAX_PAYLOAD_BYTES = 120_000

// Overhead for JSON wrapper, info, href, etc. (~500 bytes is generous)
const PAYLOAD_OVERHEAD = 500

interface Chunk {
  title: string
  payload: Record<string, unknown>
}

function buildChunks(title: string, content: string, language: string | undefined, version: number): Chunk[] {
  // Try as a single payload first
  const singlePayload: Record<string, unknown> = { title, content, version }
  if (language) singlePayload.language = language
  const singleSize = new TextEncoder().encode(JSON.stringify(singlePayload)).length + PAYLOAD_OVERHEAD
  if (singleSize <= MAX_PAYLOAD_BYTES) {
    return [{ title, payload: singlePayload }]
  }

  // Split by lines
  const lines = content.split('\n')
  const chunks: Chunk[] = []
  let startLine = 0

  while (startLine < lines.length) {
    // Binary search for how many lines fit
    let lo = 1
    let hi = lines.length - startLine
    let best = 1

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2)
      const chunkContent = lines.slice(startLine, startLine + mid).join('\n')
      const testPayload: Record<string, unknown> = { title, content: chunkContent, version }
      if (language) testPayload.language = language
      const size = new TextEncoder().encode(JSON.stringify(testPayload)).length + PAYLOAD_OVERHEAD
      if (size <= MAX_PAYLOAD_BYTES) {
        best = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    const endLine = startLine + best
    const chunkContent = lines.slice(startLine, endLine).join('\n')
    const chunkTitle = `${title} (${startLine + 1}-${endLine})`
    const payload: Record<string, unknown> = { title: chunkTitle, content: chunkContent, version, startLine: startLine + 1 }
    if (language) payload.language = language
    chunks.push({ title: chunkTitle, payload })
    startLine = endLine
  }

  return chunks
}

export const fileReviewerApp: WebXDCApp = {
  id: 'file-reviewer',

  instructions: 'When you receive file review comments from the File Reviewer app, read each comment carefully. Find the referenced lines or paragraphs using the context provided. Apply the requested changes to the file content. Reply in the chat summarizing what you changed. Send the updated file back using dc_send_file with the same title.',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_send_file',
        description: 'Send a file to a Delta Chat chat as a WebXDC viewer app. Supports rendered markdown (omit language) and syntax-highlighted source code (provide language). The first call sends the viewer app; subsequent calls to the same chat reuse it. Large files are automatically split into chunks. Provide content directly OR file_path to read from disk.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to send to' },
            title: { type: 'string', description: 'Document title (shown in the tab bar)' },
            content: { type: 'string', description: 'File content (markdown or source code). Omit if using file_path.' },
            file_path: { type: 'string', description: 'Absolute path to read file content from disk. Use for large files. Omit if providing content directly.' },
            language: { type: 'string', description: 'Language for syntax highlighting (js, ts, html, css, json, python, bash). Omit for rendered markdown.' },
          },
          required: ['chat_id', 'title'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_send_file') return null

    const chatId = Number(args.chat_id as string)
    const title = ((args.title as string) ?? '').trim()
    const filePath = (args.file_path as string | undefined) ?? undefined
    let content = (args.content as string) ?? ''
    const language = (args.language as string | undefined) ?? undefined

    // Read from disk if file_path provided
    if (filePath && !content) {
      const { readFileSync, existsSync } = await import('node:fs')
      if (!existsSync(filePath)) {
        return { content: [{ type: 'text', text: `dc_send_file: file not found: ${filePath}` }], isError: true }
      }
      content = readFileSync(filePath, 'utf-8')
    }

    if (!chatId || Number.isNaN(chatId) || !title || !content) {
      return { content: [{ type: 'text', text: 'dc_send_file: chat_id, title, and (content or file_path) are required' }], isError: true }
    }
    if (!ctx.isAllowed(chatId)) {
      return { content: [{ type: 'text', text: `dc_send_file: chat ${chatId} is not on the allowlist` }], isError: true }
    }

    const version = fileReviewer.getViewerVersion()

    // Build chunks: split content into pieces that fit within the payload limit
    const chunks = buildChunks(title, content, language, version)

    // info + href create a tappable notification that opens the app
    const fileIcons: Record<string, string> = {
      js: '\u{1f7e8}', ts: '\u{1f535}', python: '\u{1f40d}', bash: '\u{1f4df}',
      html: '\u{1f310}', css: '\u{1f3a8}', json: '\u{1f4cb}',
    }
    const icon = (language && fileIcons[language]) || '\u{1f4c4}'

    // Ensure viewer exists
    let viewerMsgId = fileReviewer.getViewer(chatId)
    if (!viewerMsgId) {
      const { xdcPath } = await fileReviewer.buildViewerXDC()
      viewerMsgId = await ctx.client.sendWebXDC(chatId, xdcPath)
      fileReviewer.setViewer(chatId, viewerMsgId)
      ctx.registerWebXDCMsg(viewerMsgId, this, chatId)
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(xdcPath) } catch {}
    }

    // Send each chunk as a separate tab
    for (const chunk of chunks) {
      const prefix = `Tap to review ${icon} `
      const maxTitle = 50 - prefix.length
      const shortTitle = chunk.title.length > maxTitle ? chunk.title.slice(0, maxTitle - 1) + '\u2026' : chunk.title
      const updateObj: Record<string, unknown> = {
        payload: chunk.payload,
        info: prefix + shortTitle,
        href: 'index.html',
      }
      const update = JSON.stringify(updateObj)
      await ctx.client.sendWebXDCUpdate(viewerMsgId, update)
      // Save last update for replay after version mismatch upgrade
      const session = fileReviewer.getSession(chatId)
      if (session) session.lastUpdate = update
    }

    const chunkNote = chunks.length > 1 ? ` (${chunks.length} parts)` : ''
    return { content: [{ type: 'text', text: `Sent "${title}"${chunkNote} to file reviewer in chat ${chatId}.` }] }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    // Find which chat owns this msgId — if the msgId no longer matches
    // (e.g. already replaced by a version upgrade), bail out.
    let ownerChatId: number | null = null
    for (const chatId of fileReviewer.viewerChatIds()) {
      if (fileReviewer.getViewer(chatId) === msgId) { ownerChatId = chatId; break }
    }
    if (ownerChatId === null) return

    const session = fileReviewer.getSession(ownerChatId)
    if (!session || session.msgId !== msgId) return

    for (const u of updates) {
      const payload = u.payload as { type?: string } | null
      if (!payload) continue

      if (payload.type === 'comments') {
        const data = payload as {
          type: string
          fileTitle?: string
          language?: string
          comments?: { line?: number; paragraph?: number; context?: string; comment?: string }[]
        }
        const comments = data.comments ?? []
        if (comments.length === 0) continue

        const langLabel = data.language ? ` (${data.language})` : ''
        const lines = comments.map(c => {
          const anchor = c.line != null ? `Line ${c.line}` : `Paragraph ${c.paragraph}`
          const ctx_str = c.context ? `: \`${c.context}\`` : ''
          return `${anchor}${ctx_str}\n  \u2192 ${c.comment}`
        })
        const text = `File review comments for "${data.fileTitle ?? 'unknown'}"${langLabel}:\n\n${lines.join('\n\n')}\n\nPlease review these comments and send back an updated file using dc_send_file.`

        ctx.logf('file-reviewer: %d comments for "%s" from chat %d', comments.length, data.fileTitle, ownerChatId)
        ctx.mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: text,
            meta: {
              chat_id: String(ownerChatId),
              user: 'File Reviewer',
              ts: new Date().toISOString(),
            },
          },
        }).catch(err => ctx.logf('file-reviewer: notification error: %v', err))
        continue
      }

      if (payload.type !== 'version_mismatch') continue

      // Guard: check session still owns this msgId (concurrent handler may have already upgraded)
      if (fileReviewer.getViewer(ownerChatId) !== msgId) return

      ctx.logf('file-reviewer: version mismatch from chat %d, resending app', ownerChatId)
      const lastUpdate = session.lastUpdate
      ctx.unregisterWebXDCMsg(msgId)
      fileReviewer.deleteViewer(ownerChatId)
      const { xdcPath } = await fileReviewer.buildViewerXDC()
      const newMsgId = await ctx.client.sendWebXDC(ownerChatId, xdcPath)
      fileReviewer.setViewer(ownerChatId, newMsgId)
      ctx.registerWebXDCMsg(newMsgId, this, ownerChatId)
      if (lastUpdate) {
        // Rebuild payload with current version (not stale version from lastUpdate)
        const parsed = JSON.parse(lastUpdate)
        if (parsed.payload) parsed.payload.version = fileReviewer.getViewerVersion()
        const freshUpdate = JSON.stringify(parsed)
        await ctx.client.sendWebXDCUpdate(newMsgId, freshUpdate)
        const newSession = fileReviewer.getSession(ownerChatId)
        if (newSession) newSession.lastUpdate = freshUpdate
      }
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(xdcPath) } catch {}
      return
    }
  },
}
