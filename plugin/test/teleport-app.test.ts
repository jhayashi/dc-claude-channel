import { test, expect } from 'bun:test'
import { handleTeleportOutCommit, handleResumeAttach } from '../apps/teleport-app.js'
import { markCurrentChat } from '../teleport-core.js'
import type { TeleportOutChat } from '../teleport-core.js'

function fakes(authOk: boolean) {
  const sent: any[] = []
  const calls = { build: 0, evict: 0 }
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) }, send: async () => {}, getChatName: async () => 'X' },
    subagentCache: { evictChat: async () => { calls.evict++ } },
    scheduleStore: { deleteForChat: () => 0, moveForChat: () => 0 },
    cleanupChatState: async () => {}, logf: () => {},
  }
  const auth = async () => authOk ? { ok: true } as const : { ok: false, reason: 'needs-confirmation' } as const
  return { ctx, sent, calls, auth }
}

test('refuses teleport_out_commit when not authorized → emits auth error, no side effects', async () => {
  const { ctx, sent, calls, auth } = fakes(false)
  await handleTeleportOutCommit(ctx, 99 /*msgId*/, { requestId: 1, chatId: 42 }, auth)
  expect(sent.some(p => p.type === 'teleport_out_error' && p.step === 'auth')).toBe(true)
  expect(calls.evict).toBe(0)
})

test('authorized → passes the gate (no auth error emitted)', async () => {
  const { ctx, sent, auth } = fakes(true)
  await handleTeleportOutCommit(ctx, 99, { requestId: 1, chatId: 42 }, auth)
  // The real assertion: when authorized, the handler does NOT short-circuit
  // with an auth error — it proceeds into the teleport flow.
  expect(sent.some(p => p.type === 'teleport_out_error' && p.step === 'auth')).toBe(false)
})

// ── P2: isCurrent marking ───────────────────────────────────────────────────

test('markCurrentChat: only the matching chatId row gets isCurrent=true', () => {
  // Build a production-shaped row set WITHOUT pre-setting isCurrent —
  // the point is to prove the server sets it, not that a fixture does.
  const makeRow = (chatId: number): TeleportOutChat => ({
    chatId,
    chatName: `Chat ${chatId}`,
    agentId: null,
    agentName: null,
    lastActiveMs: null,
    jobCount: 0,
    isTrusted: false,
    isLive: false,
    sessionId: null,
    workingDir: null,
    // isCurrent intentionally NOT set — we prove the helper sets it
  })
  const list = [makeRow(10), makeRow(20), makeRow(30)]

  // Simulate the card being opened from chat 20.
  markCurrentChat(list, 20)

  expect(list.find(r => r.chatId === 10)?.isCurrent).toBe(false)
  expect(list.find(r => r.chatId === 20)?.isCurrent).toBe(true)
  expect(list.find(r => r.chatId === 30)?.isCurrent).toBe(false)
})

test('markCurrentChat: chatId not in list → all rows falsy', () => {
  const list = [
    { chatId: 1, chatName: 'A', agentId: null, agentName: null, lastActiveMs: null, jobCount: 0, isTrusted: false, isLive: false, sessionId: null, workingDir: null },
  ] as TeleportOutChat[]
  markCurrentChat(list, 99)
  expect(list[0].isCurrent).toBe(false)
})

// ── Auth gate tests ─────────────────────────────────────────────────────────

test('refuses resume_attach when not authorized → emits resume_attach_err, no side effects', async () => {
  const created: number[] = []
  const sent: any[] = []
  const ctx: any = {
    client: {
      sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) },
      createGroup: async (name: string) => { created.push(1); return 999 },
      addContactToChat: async () => {},
      getChatContacts: async () => [2],
    },
    logf: () => {},
  }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' }) as const
  await handleResumeAttach(ctx, 99 /*msgId*/, 42 /*sourceChatId*/, { requestId: 7, sessionId: 'abc123' }, auth)
  expect(sent.some(p => p.type === 'resume_attach_err')).toBe(true)
  expect(created.length).toBe(0)
})

test('import refusal copy is direction-correct — never advises the OUT phrase (#134)', async () => {
  // The old copy reused teleport-out's advice: "say 'teleport this
  // session'" — which routes to dc_resume_in_terminal and performs the
  // OPPOSITE operation (exports the group chat to the terminal).
  const sent: any[] = []
  const ctx: any = {
    client: {
      sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) },
      createGroup: async () => 999,
      addContactToChat: async () => {},
      getChatContacts: async () => [2],
    },
    logf: () => {},
  }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' }) as const
  await handleResumeAttach(ctx, 99, 42, { requestId: 7, sessionId: 'abc123' }, auth)
  const err = sent.find(p => p.type === 'resume_attach_err')
  expect(err.message).not.toContain("teleport this session")
  expect(err.message.toLowerCase()).toContain('import')
})
