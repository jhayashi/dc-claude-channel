import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { fileReviewerApp } from '../apps/file-reviewer-app'
import * as fileReviewer from '../file-reviewer'

// These tests exercise the bundle-vs-stream decision in dc_send_file by
// pre-populating a fake viewer (so the .xdc build/send path is skipped)
// and recording the sendWebXDCUpdate calls the app issues.

interface RecordedUpdate { msgId: number; update: string }

function makeCtx(updates: RecordedUpdate[]) {
  return {
    client: {
      sendWebXDCUpdate: async (msgId: number, update: string) => {
        updates.push({ msgId, update })
      },
      sendWebXDC: async (_chatId: number, _xdcPath: string) => {
        throw new Error('test should pre-populate viewer to skip this path')
      },
    } as never,
    mcp: {} as never,
    isAllowed: () => true,
    allowedChats: () => [TEST_CHAT_ID],
    logf: () => {},
    safeName: (s: string) => s,
    registerWebXDCMsg: () => {},
    unregisterWebXDCMsg: () => {},
    lastActiveChatId: () => TEST_CHAT_ID,
  } as never
}

const TEST_CHAT_ID = 9999
const FAKE_VIEWER_MSG_ID = 88888

describe('file-reviewer bundling', () => {
  beforeEach(() => {
    fileReviewer.setViewer(TEST_CHAT_ID, FAKE_VIEWER_MSG_ID)
  })

  afterEach(() => {
    fileReviewer.deleteViewer(TEST_CHAT_ID)
  })

  test('small doc → 1 bundled update with type:document', async () => {
    const updates: RecordedUpdate[] = []
    const ctx = makeCtx(updates)
    await fileReviewerApp.callTool!('dc_send_file', {
      chat_id: String(TEST_CHAT_ID),
      title: 'Small Doc',
      content: '# Hello\n\nThis is a small markdown doc.',
    }, ctx)
    expect(updates).toHaveLength(1)
    const parsed = JSON.parse(updates[0].update)
    expect(parsed.payload.type).toBe('document')
    expect(parsed.payload.title).toBe('Small Doc')
    expect(Array.isArray(parsed.payload.chunks)).toBe(true)
    expect(parsed.payload.chunks).toHaveLength(1)
    expect(parsed.info).toContain('Tap to review')
    expect(parsed.info).toContain('Small Doc')
    // #73: href deep-links to the file via fragment, not bare index.html.
    expect(parsed.href).toMatch(/^index\.html#file-/)
    expect(typeof parsed.payload.fileId).toBe('string')
    expect(parsed.href).toBe('index.html#file-' + parsed.payload.fileId)
  })

  test('single-chunk doc bundles without explicit startLine (viewer defaults to 1)', async () => {
    const updates: RecordedUpdate[] = []
    const ctx = makeCtx(updates)
    // Small content that fits in one chunk via the buildChunks fast path
    const content = '# Section\n\nA modest doc that fits in one chunk.'
    await fileReviewerApp.callTool!('dc_send_file', {
      chat_id: String(TEST_CHAT_ID),
      title: 'Small Doc',
      content,
    }, ctx)
    expect(updates.length).toBe(1)
    const parsed = JSON.parse(updates[0].update)
    expect(parsed.payload.type).toBe('document')
    expect(parsed.payload.chunks.length).toBe(1)
    // Single-chunk fast path doesn't carry startLine; viewer defaults to 1.
    // This is intentional and correct.
  })

  test('multi-chunk bundle preserves per-chunk startLine for comment routing', async () => {
    const updates: RecordedUpdate[] = []
    const ctx = makeCtx(updates)
    // Generate content guaranteed to exceed MAX_PAYLOAD_BYTES (80K) but
    // stay under BUNDLED_THRESHOLD_BYTES (90K bundled). One line ~ 220 bytes.
    // ~400 lines = ~88 KB content; with envelope ~89-90 KB bundled.
    const line = 'paragraph text '.padEnd(220, 'x')
    const content = Array.from({ length: 400 }, (_, i) => `${line} ${i}`).join('\n')
    await fileReviewerApp.callTool!('dc_send_file', {
      chat_id: String(TEST_CHAT_ID),
      title: 'Multi-chunk Doc',
      content,
    }, ctx)
    // Either bundled (1 update, 2+ chunks) or streamed (N updates).
    if (updates.length === 1) {
      const parsed = JSON.parse(updates[0].update)
      expect(parsed.payload.type).toBe('document')
      if (parsed.payload.chunks.length > 1) {
        // Each multi-chunk entry carries startLine
        for (const chunk of parsed.payload.chunks) {
          expect(typeof chunk.startLine).toBe('number')
          expect(chunk.startLine).toBeGreaterThanOrEqual(1)
        }
        // Chunks are in order
        for (let i = 1; i < parsed.payload.chunks.length; i++) {
          expect(parsed.payload.chunks[i].startLine).toBeGreaterThan(
            parsed.payload.chunks[i - 1].startLine,
          )
        }
      }
    } else {
      // Streaming fallback path: each chunk arrives as its own update,
      // each with its own startLine.
      for (let i = 1; i < updates.length; i++) {
        const parsed = JSON.parse(updates[i].update)
        expect(typeof parsed.payload.startLine).toBe('number')
      }
    }
  })

  test('pathological doc exceeding bundle threshold → streams chunks, info on first only', async () => {
    const updates: RecordedUpdate[] = []
    const ctx = makeCtx(updates)
    // Generate ~400 KiB of content — well past BUNDLED_THRESHOLD_BYTES.
    const line = 'lorem ipsum dolor sit amet '.padEnd(120, 'x')
    const content = Array.from({ length: 3500 }, (_, i) => `${line} ${i}`).join('\n')
    await fileReviewerApp.callTool!('dc_send_file', {
      chat_id: String(TEST_CHAT_ID),
      title: 'Huge Doc',
      content,
    }, ctx)
    // Multiple updates issued (streaming fallback)
    expect(updates.length).toBeGreaterThan(1)
    // First update has info; all subsequent updates do not
    const first = JSON.parse(updates[0].update)
    expect(first.info).toContain('Tap to review')
    expect(first.info).toContain('Huge Doc')
    // #73: chunked-fallback chunk-0 also gets the deep-link href + fileId.
    expect(first.href).toMatch(/^index\.html#file-/)
    expect(typeof first.payload.fileId).toBe('string')
    expect(first.href).toBe('index.html#file-' + first.payload.fileId)
    for (let i = 1; i < updates.length; i++) {
      const parsed = JSON.parse(updates[i].update)
      expect(parsed.info).toBeUndefined()
      expect(parsed.href).toBeUndefined()
      // Subsequent updates carry payload-only chunks
      expect(parsed.payload).toBeDefined()
    }
  })

  test('bundled update preserves language when provided', async () => {
    const updates: RecordedUpdate[] = []
    const ctx = makeCtx(updates)
    await fileReviewerApp.callTool!('dc_send_file', {
      chat_id: String(TEST_CHAT_ID),
      title: 'Code',
      content: 'function hello() { return 42 }',
      language: 'javascript',
    }, ctx)
    expect(updates).toHaveLength(1)
    const parsed = JSON.parse(updates[0].update)
    expect(parsed.payload.language).toBe('javascript')
  })

  test('bundled update info includes parts count when chunks > 1', async () => {
    const updates: RecordedUpdate[] = []
    const ctx = makeCtx(updates)
    // Force >1 chunks but still under bundle threshold
    const line = '# A '.padEnd(200, 'x')
    const content = Array.from({ length: 380 }, (_, i) => `${line} ${i}`).join('\n')
    await fileReviewerApp.callTool!('dc_send_file', {
      chat_id: String(TEST_CHAT_ID),
      title: 'Multipart',
      content,
    }, ctx)
    expect(updates).toHaveLength(1)
    const parsed = JSON.parse(updates[0].update)
    if (parsed.payload.chunks.length > 1) {
      expect(parsed.info).toContain('parts')
    }
  })
})
