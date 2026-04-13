import type { WebXDCApp, ToolDef, ToolResult, AppContext } from '../webxdc-app.js'
import type { WebXDCUpdate } from '../dc-client.js'
import * as slideViewer from '../slide-viewer.js'

export const slideViewerApp: WebXDCApp = {
  id: 'slide-viewer',

  instructions: 'Use dc_send_slides to present Marp-format slide decks in Delta Chat. Marp uses YAML frontmatter (optional) + slides separated by `---`. Each slide is standard markdown. Use this when the user asks for a presentation, slide deck, or when content is naturally structured as sequential slides.',

  tools(): ToolDef[] {
    return [
      {
        name: 'dc_send_slides',
        description: 'Send a Marp-format slide deck to a Delta Chat chat as an interactive slide viewer. Supports YAML frontmatter, --- slide separators, and full markdown per slide (headings, lists, code blocks, tables, blockquotes, links, images, emphasis). The first call sends the viewer app; subsequent calls reuse it.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'Chat ID to send to' },
            title: { type: 'string', description: 'Deck title (shown in the header)' },
            content: { type: 'string', description: 'Marp-format markdown: optional YAML frontmatter between --- fences, then slides separated by ---' },
          },
          required: ['chat_id', 'title', 'content'],
        },
      },
    ]
  },

  async callTool(name: string, args: Record<string, unknown>, ctx: AppContext): Promise<ToolResult | null> {
    if (name !== 'dc_send_slides') return null

    const chatId = Number(args.chat_id as string)
    const title = ((args.title as string) ?? '').trim()
    const content = ((args.content as string) ?? '').trim()

    if (!chatId || Number.isNaN(chatId) || !title || !content) {
      return { content: [{ type: 'text', text: 'dc_send_slides: chat_id, title, and content are required' }], isError: true }
    }
    if (!ctx.isAllowed(chatId)) {
      return { content: [{ type: 'text', text: `dc_send_slides: chat ${chatId} is not on the allowlist` }], isError: true }
    }

    const version = slideViewer.getViewerVersion()

    // Ensure viewer exists
    let viewerMsgId = slideViewer.getViewer(chatId)
    if (!viewerMsgId) {
      const { xdcPath } = await slideViewer.buildViewerXDC()
      viewerMsgId = await ctx.client.sendWebXDC(chatId, xdcPath)
      slideViewer.setViewer(chatId, viewerMsgId)
      ctx.registerWebXDCMsg(viewerMsgId, this, chatId)
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(xdcPath) } catch {}
    }

    const payload = { type: 'slides', title, content, version }
    const updateObj = {
      payload,
      info: `\ud83d\udcca Tap to view: ${title.length > 40 ? title.slice(0, 39) + '\u2026' : title}`,
      href: 'index.html',
    }
    const update = JSON.stringify(updateObj)
    await ctx.client.sendWebXDCUpdate(viewerMsgId, update)

    // Save for replay after version mismatch upgrade
    const session = slideViewer.getSession(chatId)
    if (session) session.lastUpdate = update

    // Count slides for feedback
    const slideCount = content.split(/\n---\s*\n/).filter(function(s) { return s.trim(); }).length
    return { content: [{ type: 'text', text: `Sent "${title}" (${slideCount} slides) to slide viewer in chat ${chatId}.` }] }
  },

  async onWebXDCUpdate(msgId: number, updates: WebXDCUpdate[], ctx: AppContext): Promise<void> {
    let ownerChatId: number | null = null
    for (const chatId of slideViewer.viewerChatIds()) {
      if (slideViewer.getViewer(chatId) === msgId) { ownerChatId = chatId; break }
    }
    if (ownerChatId === null) return

    const session = slideViewer.getSession(ownerChatId)
    if (!session || session.msgId !== msgId) return

    for (const u of updates) {
      const payload = u.payload as { type?: string } | null
      if (!payload || payload.type !== 'version_mismatch') continue

      if (slideViewer.getViewer(ownerChatId) !== msgId) return

      ctx.logf('slide-viewer: version mismatch from chat %d, resending app', ownerChatId)
      const lastUpdate = session.lastUpdate
      ctx.unregisterWebXDCMsg(msgId)
      slideViewer.deleteViewer(ownerChatId)
      const { xdcPath } = await slideViewer.buildViewerXDC()
      const newMsgId = await ctx.client.sendWebXDC(ownerChatId, xdcPath)
      slideViewer.setViewer(ownerChatId, newMsgId)
      ctx.registerWebXDCMsg(newMsgId, this, ownerChatId)
      if (lastUpdate) {
        const parsed = JSON.parse(lastUpdate)
        if (parsed.payload) parsed.payload.version = slideViewer.getViewerVersion()
        const freshUpdate = JSON.stringify(parsed)
        await ctx.client.sendWebXDCUpdate(newMsgId, freshUpdate)
        const newSession = slideViewer.getSession(ownerChatId)
        if (newSession) newSession.lastUpdate = freshUpdate
      }
      const { unlinkSync } = await import('node:fs')
      try { unlinkSync(xdcPath) } catch {}
      return
    }
  },
}
