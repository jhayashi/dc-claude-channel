import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as fileReviewer from '../file-reviewer.js'
import { getBinding } from '../bindings.js'

// #78: hard cap on export-as-attachment file size. The assembled content
// (all chunks of a logical file concatenated) must fit under this to be
// exported. Leaves headroom under DC core's sendUpdate ceiling for the
// JSON wrapper. Must match the JS-side constant in file-reviewer.html.
export const MAX_EXPORT_BYTES = 100_000

// #78: file extension inference for export-as-attachment. Used when the
// document's title doesn't already have an extension. Order: title ext
// (kept) → this map → '.txt' fallback. Conservative — only well-known
// languages map to a sensible extension; unknown languages fall to .txt
// (don't mislead the user about format).
const LANG_TO_EXT: Record<string, string> = {
  javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh',
  go: 'go', rust: 'rs', java: 'java', ruby: 'rb', php: 'php',
  json: 'json', yaml: 'yml', toml: 'toml', markdown: 'md',
  markup: 'html', css: 'css', diff: 'diff', sql: 'sql',
}

// DC core's STATUS_UPDATE_SIZE_MAX is 100 KiB (102_400 bytes) — the
// per-SMTP-batch soft limit at which `flush_status_updates` splits the
// queued updates into multiple SMTP messages. We aim chunks well below
// that so a single chunk fits in a single SMTP batch with margin for
// the {"updates":[...]} envelope DC core wraps around it.
const MAX_PAYLOAD_BYTES = 80_000

// Bundling threshold: if the entire document (all chunks combined into a
// single sendUpdate call) fits under this size, we send as one update —
// guaranteeing one SMTP send. Beyond this, we fall back to streaming
// chunks and rely on the dc-client rate limiter to pace them.
const BUNDLED_THRESHOLD_BYTES = 90_000

// Overhead for JSON wrapper, info, href, etc. (~500 bytes is generous)
const PAYLOAD_OVERHEAD = 500

// Map file extensions to Prism language ids. Keep in sync with the
// grammars bundled by plugin/scripts/build-viewer-html.ts.
const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python',
  sh: 'bash', bash: 'bash',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
  css: 'css',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  md: 'markdown', markdown: 'markdown',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  go: 'go',
  rs: 'rust',
  swift: 'swift',
  sql: 'sql',
  diff: 'diff', patch: 'diff',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  ps1: 'powershell', psm1: 'powershell',
  graphql: 'graphql', gql: 'graphql',
  lua: 'lua',
  r: 'r',
  dockerfile: 'docker',
}

export function langFromPath(filePath: string): string | undefined {
  const base = filePath.split('/').pop() ?? filePath
  if (base.toLowerCase() === 'dockerfile') return 'docker'
  if (base.toLowerCase() === 'makefile') return 'makefile'
  const dot = base.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext]
}

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

  instructions: [
    'Prefer dc_send_file (File Reviewer) over inline chat messages for any structured or long markdown you produce: plans, proposals, specs, designs, reviews, reports, changelogs, or any reply with headings, multiple bullet sections, or more than ~15 lines. The user can scroll, comment inline on specific lines or paragraphs, and reply with targeted edits — inline chat messages can only be read top-to-bottom. Example: when asked "write me a plan for X", send the plan via dc_send_file with a short title (e.g. "X plan"), not as an inline reply. Short conversational replies, single-paragraph answers, and quick status updates stay inline. This is a default, not a hard rule — use judgment.',
    'When you receive file review comments from the File Reviewer app, read each comment carefully. Find the referenced lines or paragraphs using the context provided. Apply the requested changes to the file content. Reply in the chat summarizing what you changed. Send the updated file back using dc_send_file with the same title.',
  ].join('\n\n'),

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_send_file',
        requiresCapability: 'private_data_write',
        description: 'Send a file to a Delta Chat chat as a WebXDC viewer app. Supports rendered markdown (omit language) and syntax-highlighted source code (provide language, or omit and let file_path extension auto-detect it). The first call sends the viewer app; subsequent calls to the same chat reuse it. Large files are automatically split into chunks. Provide content directly OR file_path to read from disk.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to send to' },
            title: { type: 'string', description: 'Document title (shown in the tab bar)' },
            content: { type: 'string', description: 'File content (markdown or source code). Omit if using file_path.' },
            file_path: { type: 'string', description: 'Absolute path to read file content from disk. Use for large files. Omit if providing content directly.' },
            language: { type: 'string', description: 'Language for syntax highlighting (javascript, typescript, python, bash, markup, css, json, yaml, toml, go, rust, java, c, cpp, ruby, php, csharp, sql, diff, and more). Omit to render as markdown, or omit with file_path to auto-detect from extension.' },
          },
          required: ['chat_id', 'title'],
        },
      },
      {
        name: 'dc_send_slides',
        requiresCapability: 'private_data_write',
        description: 'Send a Marp-format slide deck to a Delta Chat chat. Rendered by the file reviewer with auto-detected slide mode: use YAML frontmatter `marp: true` or structure the doc as `---`-separated sections with no pre-content. Commenting still works per-block within each slide.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to send to' },
            title: { type: 'string', description: 'Deck title (shown in the tab bar)' },
            content: { type: 'string', description: 'Marp-format markdown: optional YAML frontmatter between --- fences, then slides separated by ---' },
          },
          required: ['chat_id', 'title', 'content'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name === 'dc_send_slides') {
      // Thin alias: reuse dc_send_file path. The viewer auto-detects Marp
      // structure from the content and switches to slide mode.
      return this.callTool('dc_send_file', {
        chat_id: args.chat_id,
        title: args.title,
        content: args.content,
      }, ctx)
    }
    if (name !== 'dc_send_file') return null

    const chatId = Number(args.chat_id as string)
    const title = ((args.title as string) ?? '').trim()
    const filePath = (args.file_path as string | undefined) ?? undefined
    let content = (args.content as string) ?? ''
    let language = (args.language as string | undefined) ?? undefined

    // Read from disk if file_path provided
    if (filePath && !content) {
      const { readFileSync, existsSync } = await import('node:fs')
      if (!existsSync(filePath)) {
        return { content: [{ type: 'text', text: `dc_send_file: file not found: ${filePath}` }], isError: true }
      }
      content = readFileSync(filePath, 'utf-8')
    }

    // Auto-detect language from file_path extension when not explicitly set.
    // Markdown extensions are intentionally left undetected so the viewer
    // renders them instead of syntax-highlighting the source.
    if (!language && filePath) {
      const detected = langFromPath(filePath)
      if (detected && detected !== 'markdown') language = detected
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
      javascript: '\u{1f7e8}', typescript: '\u{1f535}', python: '\u{1f40d}', bash: '\u{1f4df}',
      markup: '\u{1f310}', css: '\u{1f3a8}', json: '\u{1f4cb}', yaml: '\u{1f4dd}',
      toml: '\u{1f4dd}', go: '\u{1f439}', rust: '\u{1f980}', java: '\u{2615}',
      ruby: '\u{1f48e}', diff: '\u{1f504}',
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

    const prefix = `Tap to review ${icon} `
    const maxTitle = 50 - prefix.length
    const shortTitle = title.length > maxTitle ? title.slice(0, maxTitle - 1) + '\u2026' : title
    const partsNote = chunks.length > 1 ? ` (${chunks.length} parts)` : ''

    // Stable per-call id used for notification deep-linking (#73). Both
    // the payload and the href carry it; the receiver matches the URL
    // fragment against doc.fileId on cold open / hashchange to land on
    // the right file regardless of how many docs were sent after.
    const fileId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

    // Try bundled-update path first: one sendUpdate carrying all chunks.
    // For typical-sized docs this means one SMTP send instead of N. The
    // per-chunk startLine fields are preserved so comment routing still
    // resolves to absolute line numbers in the viewer.
    //
    // #78 pre-req: every chunk's payload carries fileId so the
    // export-as-attachment assembler in the viewer can group chunks of
    // the same logical file. Pre-#78 only chunk 0 carried fileId (for
    // notification deep-linking); now all chunks share the file's id.
    const bundledUpdateObj = {
      payload: {
        type: 'document',
        title,
        version,
        fileId,
        ...(language ? { language } : {}),
        chunks: chunks.map((c) => ({ ...c.payload, fileId })),
      },
      info: prefix + shortTitle + partsNote,
      href: `index.html#file-${fileId}`,
    }
    const bundledUpdate = JSON.stringify(bundledUpdateObj)
    const bundledSize = new TextEncoder().encode(bundledUpdate).length

    if (bundledSize <= BUNDLED_THRESHOLD_BYTES) {
      await ctx.client.sendWebXDCUpdate(viewerMsgId, bundledUpdate)
      fileReviewer.setLastUpdate(chatId, bundledUpdate)
    } else {
      // Pathological-doc fallback: stream chunks individually. The
      // dc-client rate limiter paces these to avoid the chatmail GCRA
      // bucket. info on the first chunk only \u2014 subsequent chunks are
      // silent payload-only updates so the chat shows one notification
      // per document, not one per chunk.
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        const chunkShortTitle = chunk.title.length > maxTitle
          ? chunk.title.slice(0, maxTitle - 1) + '\u2026'
          : chunk.title
        // Chunk 0 carries the notification + deep-link href so tapping
        // the notification lands on the start of the file (#73).
        // Every chunk carries fileId (#78 pre-req) so the export-as-
        // attachment assembler can group chunks of the same logical file.
        const chunkPayload = { ...chunk.payload, fileId }
        const updateObj: Record<string, unknown> = { payload: chunkPayload }
        if (i === 0) {
          updateObj.info = prefix + chunkShortTitle + partsNote
          updateObj.href = `index.html#file-${fileId}`
        }
        const update = JSON.stringify(updateObj)
        await ctx.client.sendWebXDCUpdate(viewerMsgId, update)
        fileReviewer.setLastUpdate(chatId, update)
      }
    }

    return { content: [{ type: 'text', text: `Sent "${title}"${partsNote} to file reviewer in chat ${chatId}.` }] }
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
          comments?: { line?: number; paragraph?: number; slide?: number; context?: string; comment?: string }[]
        }
        const comments = data.comments ?? []
        if (comments.length === 0) continue

        const langLabel = data.language ? ` (${data.language})` : ''
        const lines = comments.map(c => {
          let anchor: string
          if (c.line != null) {
            anchor = `Line ${c.line}`
          } else if (c.slide != null) {
            anchor = `Slide ${c.slide + 1} / Block ${(c.paragraph ?? 0) + 1}`
          } else {
            anchor = `Paragraph ${c.paragraph}`
          }
          const ctx_str = c.context ? `: \`${c.context}\`` : ''
          return `${anchor}${ctx_str}\n  \u2192 ${c.comment}`
        })
        const text = `File review comments for "${data.fileTitle ?? 'unknown'}"${langLabel}:\n\n${lines.join('\n\n')}\n\nPlease review these comments and send back an updated file using dc_send_file.`

        ctx.logf('file-reviewer: %d comments for "%s" from chat %d', comments.length, data.fileTitle, ownerChatId)

        const binding = getBinding(ownerChatId)
        if (binding && ctx.dispatchAndCollect) {
          ctx.logf('file-reviewer: routing comments to subagent for chat %d', ownerChatId)
          ctx.dispatchAndCollect(ownerChatId, text).catch(err =>
            ctx.logf('file-reviewer: dispatch error chat=%d: %v', ownerChatId, err),
          )
        } else {
          ctx.logf('file-reviewer: no binding for chat %d, falling back to terminal notification', ownerChatId)
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
        }
        continue
      }

      if (payload.type === 'close_tab') {
        // Pure in-memory cleanup. Does NOT touch the filesystem or any
        // file. The "doc" only exists as content in lastUpdate; clearing
        // lastUpdate prevents a future version_mismatch upgrade from
        // restoring the closed doc.
        const data = payload as { type: string; title?: string; docIndex?: number }
        ctx.logf('file-reviewer: close_tab from chat %d, title=%s', ownerChatId, data.title ?? '')
        if (session.lastUpdate) {
          try {
            const parsed = JSON.parse(session.lastUpdate)
            if (parsed?.payload?.title === data.title) {
              fileReviewer.clearLastUpdate(ownerChatId)
              ctx.logf('file-reviewer: cleared lastUpdate for closed tab "%s" in chat %d', data.title, ownerChatId)
            }
          } catch {}
        }
        continue
      }

      if (payload.type === 'export-file') {
        // #78: send the assembled file content back to the chat as a
        // regular DC attachment. Frontend has already done the multi-
        // chunk assembly, size check, and filename inference; we just
        // write the temp file and post it.
        const data = payload as { type: string; filename?: string; content?: string }
        const filename = typeof data.filename === 'string' ? data.filename : 'export.txt'
        const content = typeof data.content === 'string' ? data.content : ''
        const requestId = (payload as { requestId?: number }).requestId ?? 0

        const sendResult = async (ok: boolean, message?: string): Promise<void> => {
          const update = JSON.stringify({
            payload: {
              type: 'export-result',
              requestId,
              ok,
              filename,
              ...(message ? { message } : {}),
              senderAddr: 'server',
            },
          })
          await ctx.client.sendWebXDCUpdate(msgId, update).catch((err) =>
            ctx.logf('file-reviewer: export-result send failed chat=%d: %v', ownerChatId, err),
          )
        }

        // Size safety net — frontend also checks, but defense-in-depth
        // against a stale/buggy client.
        const byteLen = Buffer.byteLength(content, 'utf-8')
        if (byteLen > MAX_EXPORT_BYTES) {
          ctx.logf('file-reviewer: export-file oversize chat=%d bytes=%d cap=%d',
                   ownerChatId, byteLen, MAX_EXPORT_BYTES)
          await sendResult(false, `File too large (${byteLen} bytes > ${MAX_EXPORT_BYTES} cap)`)
          continue
        }

        let dir: string | null = null
        try {
          dir = mkdtempSync(join(tmpdir(), 'dc-file-export-'))
          const path = join(dir, filename)
          writeFileSync(path, content)
          // Caption gives the chat-side reader a visible acknowledgment
          // that the file came from the reviewer, not a random attachment.
          const caption = `📎 Exported \`${filename}\` from the file reviewer.`
          await ctx.client.sendAttachment(ownerChatId, path, caption)
          ctx.logf('file-reviewer: export-file chat=%d filename=%s bytes=%d',
                   ownerChatId, filename, byteLen)
          await sendResult(true)
          // Delayed cleanup — dc-core reads the file for SMTP attach after
          // sendAttachment resolves the msgId, so immediate unlink races.
          // 60s grace is generous; outbox typically flushes in seconds.
          const cleanupDir = dir
          setTimeout(() => {
            try { unlinkSync(path) } catch {}
            try { rmSync(cleanupDir, { recursive: true, force: true }) } catch {}
          }, 60_000)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          ctx.logf('file-reviewer: export-file failed chat=%d: %v', ownerChatId, err)
          await sendResult(false, errMsg)
          if (dir) {
            try { rmSync(dir, { recursive: true, force: true }) } catch {}
          }
        }
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
        fileReviewer.setLastUpdate(ownerChatId, freshUpdate)
      }
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(xdcPath) } catch {}
      return
    }
  },

  start(ctx: AppContext): void {
    // Restore viewer sessions persisted across dispatcher restarts so
    // the next dc_send_file call reuses the existing applet card
    // instead of shipping a fresh .xdc.
    const restored = fileReviewer.loadPersistedViewers()
    for (const v of restored) {
      ctx.registerWebXDCMsg(v.msgId, this, v.chatId)
      ctx.logf('file-reviewer: restored viewer for chat %d (msg %d)', v.chatId, v.msgId)
    }
  },
}
