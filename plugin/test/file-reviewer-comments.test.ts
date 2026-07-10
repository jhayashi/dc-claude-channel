import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileReviewerApp } from '../apps/file-reviewer-app'
import * as fileReviewer from '../file-reviewer'
import * as bindings from '../bindings'

// #128 regression: a comments payload must route through dispatchAndPost
// (which surfaces the agent's response in the chat) — dispatchAndCollect
// silently discarded the reply and users saw an updated file appear with
// no explanation.

const TEST_CHAT_ID = 4242
const VIEWER_MSG_ID = 777

function makeCtx(calls: Array<{ kind: string; chatId: number; text: string }>) {
  return {
    client: {} as never,
    mcp: {
      notification: async () => {
        calls.push({ kind: 'notification', chatId: -1, text: '' })
      },
    } as never,
    isAllowed: () => true,
    allowedChats: () => [TEST_CHAT_ID],
    logf: () => {},
    safeName: (s: string) => s,
    registerWebXDCMsg: () => {},
    unregisterWebXDCMsg: () => {},
    dispatchAndPost: async (chatId: number, text: string) => {
      calls.push({ kind: 'post', chatId, text })
    },
    dispatchAndCollect: async (chatId: number, text: string) => {
      calls.push({ kind: 'collect', chatId, text })
      return 'collected'
    },
  } as never
}

describe('file-reviewer comments routing (#128)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fr-comments-'))
    bindings.setBindingsDir(dir)
    // saveBinding directly — bindAgent would heal-on-bind against the real
    // ~/.claude/agents dir, which tests must never touch.
    bindings.saveBinding({
      chatId: TEST_CHAT_ID,
      agentId: 'claude-code',
      inheritClaudeMd: false,
      createdAt: new Date().toISOString(),
    })
    fileReviewer._resetViewers()
    fileReviewer.setViewer(TEST_CHAT_ID, VIEWER_MSG_ID)
  })

  afterEach(() => {
    fileReviewer._resetViewers()
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  test('comments dispatch uses dispatchAndPost when available', async () => {
    const calls: Array<{ kind: string; chatId: number; text: string }> = []
    await fileReviewerApp.onWebXDCUpdate!(VIEWER_MSG_ID, [
      {
        payload: {
          type: 'comments',
          fileTitle: 'plan.md',
          comments: [{ paragraph: 1, comment: 'tighten this' }],
        },
        serial: 1,
      } as never,
    ], makeCtx(calls))
    // allow the fire-and-forget dispatch microtask to run
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.length).toBe(1)
    expect(calls[0].kind).toBe('post')
    expect(calls[0].chatId).toBe(TEST_CHAT_ID)
    expect(calls[0].text).toContain('tighten this')
  })

  test('falls back to dispatchAndCollect when dispatchAndPost absent', async () => {
    const calls: Array<{ kind: string; chatId: number; text: string }> = []
    const ctx = makeCtx(calls) as { dispatchAndPost?: unknown }
    delete ctx.dispatchAndPost
    await fileReviewerApp.onWebXDCUpdate!(VIEWER_MSG_ID, [
      {
        payload: {
          type: 'comments',
          fileTitle: 'plan.md',
          comments: [{ paragraph: 1, comment: 'ok' }],
        },
        serial: 1,
      } as never,
    ], ctx as never)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.length).toBe(1)
    expect(calls[0].kind).toBe('collect')
  })
})
