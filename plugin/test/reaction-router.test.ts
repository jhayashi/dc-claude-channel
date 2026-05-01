import { describe, test, expect, beforeEach } from 'bun:test'
import { ReactionRouter, formatReactionBatch } from '../dispatcher/reaction-router.ts'
import type { ReactionEvent } from '../dc-client.ts'

function makeEvent(partial: Partial<ReactionEvent> & { chatId: number; msgId: number }): ReactionEvent {
  return {
    chatId: partial.chatId,
    msgId: partial.msgId,
    fromId: partial.fromId ?? 100,
    senderName: partial.senderName ?? 'Alice',
    reaction: partial.reaction ?? '👍',
    timestamp: partial.timestamp ?? new Date(0),
  }
}

interface FakeTimer {
  cb: () => void
  ms: number
  fired: boolean
}

function makeRouter(overrides: {
  allowed?: Set<number>
  owners?: Map<number, number>
  live?: Set<number>
} = {}) {
  const allowed = overrides.allowed ?? new Set<number>([10, 20])
  const owners = overrides.owners ?? new Map<number, number>([[10, 100], [20, 200]])
  const live = overrides.live ?? new Set<number>([10, 20])
  const dispatched: Array<{ chatId: number; text: string }> = []
  const timers: FakeTimer[] = []
  const router = new ReactionRouter({
    isAllowed: (id) => allowed.has(id),
    firstPermissionedContact: (id) => owners.get(id) ?? null,
    hasLiveSubagent: (id) => live.has(id),
    dispatchSynthetic: async (chatId, text) => { dispatched.push({ chatId, text }) },
    debounceMs: 100,
    maxBufferPerChat: 3,
    setTimer: (cb, ms) => {
      const t: FakeTimer = { cb, ms, fired: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      const t = h as FakeTimer
      t.fired = true // mark as "cancelled"
    },
  })
  const fireLatest = async () => {
    // Find the most recently-added, not-yet-fired timer (debounce semantics).
    for (let i = timers.length - 1; i >= 0; i--) {
      if (!timers[i].fired) { timers[i].fired = true; timers[i].cb(); break }
    }
    // Give the async dispatch a microtask to run.
    await new Promise((r) => setTimeout(r, 0))
  }
  return { router, dispatched, fireLatest, timers }
}

describe('ReactionRouter', () => {
  test('drops reactions for unpaired chat', () => {
    const { router, dispatched, timers } = makeRouter({ allowed: new Set([10]) })
    router.handle(makeEvent({ chatId: 999, msgId: 1 }))
    expect(timers.length).toBe(0)
    expect(dispatched.length).toBe(0)
  })

  test('drops non-owner reactions in owned chat', () => {
    const { router, dispatched, timers } = makeRouter()
    router.handle(makeEvent({ chatId: 10, msgId: 1, fromId: 999 }))
    expect(timers.length).toBe(0)
    expect(dispatched.length).toBe(0)
  })

  test('drops reaction when no live subagent', () => {
    const { router, dispatched, timers } = makeRouter({ live: new Set() })
    router.handle(makeEvent({ chatId: 10, msgId: 1, fromId: 100 }))
    expect(timers.length).toBe(0)
    expect(dispatched.length).toBe(0)
  })

  test('dispatches a single reaction after debounce', async () => {
    const { router, dispatched, fireLatest } = makeRouter()
    router.handle(makeEvent({ chatId: 10, msgId: 5, fromId: 100, reaction: '🎉' }))
    expect(dispatched.length).toBe(0)
    await fireLatest()
    expect(dispatched.length).toBe(1)
    expect(dispatched[0].chatId).toBe(10)
    expect(dispatched[0].text).toContain('reacted 🎉')
    expect(dispatched[0].text).toContain('id=5')
  })

  test('batches multiple reactions inside the debounce window', async () => {
    const { router, dispatched, fireLatest } = makeRouter()
    router.handle(makeEvent({ chatId: 10, msgId: 5, fromId: 100, reaction: '👍' }))
    router.handle(makeEvent({ chatId: 10, msgId: 6, fromId: 100, reaction: '🎉' }))
    router.handle(makeEvent({ chatId: 10, msgId: 7, fromId: 100, reaction: '' }))
    expect(dispatched.length).toBe(0)
    await fireLatest()
    expect(dispatched.length).toBe(1)
    const text = dispatched[0].text
    expect(text).toContain('3 reactions')
    expect(text).toContain('👍')
    expect(text).toContain('🎉')
    expect(text).toContain('cleared their reaction on msg 7')
  })

  test('surfaces cleared-reaction events', async () => {
    const { router, dispatched, fireLatest } = makeRouter()
    router.handle(makeEvent({ chatId: 10, msgId: 5, fromId: 100, reaction: '' }))
    await fireLatest()
    expect(dispatched[0].text).toContain('cleared their reaction')
    expect(dispatched[0].text).toContain('id=5')
  })

  test('drops oldest on buffer overflow', async () => {
    const { router, dispatched, fireLatest } = makeRouter()
    router.handle(makeEvent({ chatId: 10, msgId: 1, fromId: 100, reaction: '1️⃣' }))
    router.handle(makeEvent({ chatId: 10, msgId: 2, fromId: 100, reaction: '2️⃣' }))
    router.handle(makeEvent({ chatId: 10, msgId: 3, fromId: 100, reaction: '3️⃣' }))
    router.handle(makeEvent({ chatId: 10, msgId: 4, fromId: 100, reaction: '4️⃣' })) // overflow, drops msg 1
    await fireLatest()
    expect(dispatched.length).toBe(1)
    const text = dispatched[0].text
    expect(text).not.toContain('msg 1')
    expect(text).toContain('msg 4')
  })

  test('passes reactions through in unowned (legacy) chats', async () => {
    const { router, dispatched, fireLatest } = makeRouter({
      owners: new Map(), // no owners registered
    })
    router.handle(makeEvent({ chatId: 10, msgId: 5, fromId: 999, reaction: '👍' }))
    await fireLatest()
    expect(dispatched.length).toBe(1)
  })
})

describe('formatReactionBatch', () => {
  test('single reaction format', () => {
    const text = formatReactionBatch(10, [
      { chatId: 10, msgId: 42, fromId: 100, senderName: 'Bob', reaction: '🔥', timestamp: new Date(0) },
    ])
    expect(text).toContain('[dc chat_id=10 event=reaction]')
    expect(text).toContain('Bob reacted 🔥 to your message id=42')
  })

  test('single cleared-reaction format', () => {
    const text = formatReactionBatch(10, [
      { chatId: 10, msgId: 42, fromId: 100, senderName: 'Bob', reaction: '', timestamp: new Date(0) },
    ])
    expect(text).toContain('Bob cleared their reaction on message id=42')
  })

  test('batched format mentions count', () => {
    const text = formatReactionBatch(10, [
      { chatId: 10, msgId: 1, fromId: 100, senderName: 'Bob', reaction: '👍', timestamp: new Date(0) },
      { chatId: 10, msgId: 2, fromId: 100, senderName: 'Bob', reaction: '🎉', timestamp: new Date(0) },
    ])
    expect(text).toContain('2 reactions')
    expect(text).toContain('- Bob reacted 👍 to msg 1')
    expect(text).toContain('- Bob reacted 🎉 to msg 2')
  })
})
