import { test, expect } from 'bun:test'
import { handleTeleportOutCommit } from '../apps/teleport-app.js'

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
