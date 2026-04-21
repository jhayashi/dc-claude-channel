import { describe, it, expect } from 'bun:test'
import { SubagentCache, type SubagentLike, type TurnTelemetry } from '../dispatcher/subagent-cache.js'

class FakeSubagent implements SubagentLike {
  readonly subagentId: string
  alive = true
  lastUsed = Date.now()
  public sendCount = 0
  public closed = false
  constructor(public readonly chatId: number, public readonly label: string = 'ok') {
    this.subagentId = `fake-${chatId}-${Math.random().toString(36).slice(2, 8)}`
  }
  async send(): Promise<{ text: string; denials: [] }> {
    this.sendCount++
    return { text: this.label, denials: [] }
  }
  async close(): Promise<void> { this.closed = true; this.alive = false }
}

/**
 * Send() returns a pending promise; the test controls resolution to drive
 * completed / timeout / crash / evict paths deterministically.
 */
class ControllableFakeSubagent implements SubagentLike {
  readonly subagentId: string
  alive = true
  lastUsed = Date.now()
  public closed = false
  private sendResolve: ((v: { text: string; denials: [] }) => void) | null = null
  private sendReject: ((e: Error) => void) | null = null
  constructor(public readonly chatId: number) {
    this.subagentId = `ctl-${chatId}-${Math.random().toString(36).slice(2, 8)}`
  }
  send(): Promise<{ text: string; denials: [] }> {
    return new Promise((resolve, reject) => {
      this.sendResolve = resolve
      this.sendReject = reject
    })
  }
  complete(label = 'ok'): void { this.sendResolve?.({ text: label, denials: [] }) }
  timeout(ms = 100): void { this.sendReject?.(new Error(`timeout after ${ms}ms`)) }
  die(): void { this.alive = false; this.sendReject?.(new Error('process died')) }
  async close(): Promise<void> { this.closed = true; this.alive = false }
}

describe('SubagentCache', () => {
  it('spawns on first dispatch and reuses on second', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'hi')
    await cache.dispatch(1, 'again')
    expect(spawns).toHaveLength(1)
    expect(spawns[0].sendCount).toBe(2)
    await cache.closeAll()
  })

  it('evicts the LRU chat when capacity is reached', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 2,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'a')
    await cache.dispatch(2, 'b')
    await cache.dispatch(3, 'c') // should evict chat 1
    expect(cache.size()).toBe(2)
    expect(spawns[0].closed).toBe(true) // the chat-1 sub
    expect(spawns[1].closed).toBe(false)
    expect(spawns[2].closed).toBe(false)
    await cache.closeAll()
  })

  it('touches LRU on reuse so the reused chat is not evicted', async () => {
    const subs = new Map<number, FakeSubagent>()
    const cache = new SubagentCache({
      maxActive: 2,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); subs.set(chatId, s); return s },
    })
    await cache.dispatch(1, 'a')
    await cache.dispatch(2, 'b')
    await cache.dispatch(1, 'a-again') // chat 1 is now MRU
    await cache.dispatch(3, 'c')       // should evict chat 2, not chat 1
    expect(subs.get(1)?.closed).toBe(false)
    expect(subs.get(2)?.closed).toBe(true)
    expect(subs.get(3)?.closed).toBe(false)
    await cache.closeAll()
  })

  it('respawns when a cached subagent has died', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'a')
    spawns[0].alive = false
    await cache.dispatch(1, 'b')
    expect(spawns).toHaveLength(2)
    await cache.closeAll()
  })

  it('auto-closes on idle timeout', async () => {
    const spawns: FakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 50,
      spawnFn: async (chatId) => { const s = new FakeSubagent(chatId); spawns.push(s); return s },
    })
    await cache.dispatch(1, 'a')
    await new Promise((r) => setTimeout(r, 120))
    expect(spawns[0].closed).toBe(true)
    expect(cache.size()).toBe(0)
    await cache.closeAll()
  })
})

describe('SubagentCache turn telemetry', () => {
  it('emits a completed turn event with spawnColdMs on first turn, 0 on reuse', async () => {
    const events: TurnTelemetry[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => new FakeSubagent(chatId),
      onTurnEvent: (ev) => events.push(ev),
    })
    await cache.dispatch(7, 'hi')
    await cache.dispatch(7, 'again')
    expect(events).toHaveLength(2)
    expect(events[0].chatId).toBe(7)
    expect(events[0].exitReason).toBe('completed')
    // Spawn cost is attributed entirely to the first turn.
    expect(events[0].spawnColdMs).toBeGreaterThanOrEqual(0)
    expect(events[1].spawnColdMs).toBe(0)
    // turnIds are unique per dispatch.
    expect(events[0].turnId).not.toBe(events[1].turnId)
    await cache.closeAll()
  })

  it('records toolCalls via recordToolCall() during an in-flight turn', async () => {
    const events: TurnTelemetry[] = []
    const subs: ControllableFakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new ControllableFakeSubagent(chatId); subs.push(s); return s },
      onTurnEvent: (ev) => events.push(ev),
    })
    const dispatched = cache.dispatch(3, 'work')
    // Let spawn + runNow set up the turn.
    await new Promise((r) => setTimeout(r, 10))
    const t1 = cache.recordToolCall(3)
    const t2 = cache.recordToolCall(3)
    expect(t1).toBeTruthy()
    expect(t1).toBe(t2) // same turn
    subs[0].complete('done')
    await dispatched
    expect(events).toHaveLength(1)
    expect(events[0].toolCalls).toBe(2)
    expect(events[0].turnId).toBe(t1!)
    await cache.closeAll()
  })

  it('returns null from recordToolCall when no turn is in flight', async () => {
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => new FakeSubagent(chatId),
    })
    // No subagent yet → null.
    expect(cache.recordToolCall(42)).toBe(null)
    await cache.dispatch(42, 'hi')
    // Between turns (dispatch resolved) → null.
    expect(cache.recordToolCall(42)).toBe(null)
    await cache.closeAll()
  })

  it('classifies turn_timeout when send rejects with a timeout error', async () => {
    const events: TurnTelemetry[] = []
    const subs: ControllableFakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new ControllableFakeSubagent(chatId); subs.push(s); return s },
      onTurnEvent: (ev) => events.push(ev),
    })
    const dispatched = cache.dispatch(5, 'work')
    await new Promise((r) => setTimeout(r, 10))
    subs[0].timeout(999)
    await expect(dispatched).rejects.toThrow(/timeout after/)
    expect(events).toHaveLength(1)
    expect(events[0].exitReason).toBe('turn_timeout')
    await cache.closeAll()
  })

  it('classifies crash when the subagent dies mid-send', async () => {
    const events: TurnTelemetry[] = []
    const subs: ControllableFakeSubagent[] = []
    const crashes: number[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new ControllableFakeSubagent(chatId); subs.push(s); return s },
      onCrash: (chatId) => crashes.push(chatId),
      onTurnEvent: (ev) => events.push(ev),
    })
    const dispatched = cache.dispatch(9, 'work')
    await new Promise((r) => setTimeout(r, 10))
    subs[0].die()
    await expect(dispatched).rejects.toThrow(/process died/)
    expect(events).toHaveLength(1)
    expect(events[0].exitReason).toBe('crash')
    expect(crashes).toEqual([9])
    await cache.closeAll()
  })

  it('classifies lru_evict when the cache makes room for another chat', async () => {
    const events: TurnTelemetry[] = []
    const subs: ControllableFakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 1, // forces eviction on the second dispatch
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new ControllableFakeSubagent(chatId); subs.push(s); return s },
      onTurnEvent: (ev) => events.push(ev),
    })
    const first = cache.dispatch(1, 'first')
    await new Promise((r) => setTimeout(r, 10))
    // Second dispatch to a different chat forces eviction of chat 1 via
    // ensureCapacity. The in-flight send for chat 1 will reject; the turn
    // event should record lru_evict, not crash/turn_timeout.
    const second = cache.dispatch(2, 'second')
    await new Promise((r) => setTimeout(r, 10))
    subs[0].die() // unblock the pending send for chat 1 so its runNow can finish
    await expect(first).rejects.toThrow()
    subs[1].complete('ok')
    await second
    const chat1 = events.find((e) => e.chatId === 1)
    expect(chat1?.exitReason).toBe('lru_evict')
    await cache.closeAll()
  })

  it('classifies user_abort when evictChat is called mid-turn', async () => {
    const events: TurnTelemetry[] = []
    const subs: ControllableFakeSubagent[] = []
    const cache = new SubagentCache({
      maxActive: 4,
      idleTimeoutMs: 60000,
      spawnFn: async (chatId) => { const s = new ControllableFakeSubagent(chatId); subs.push(s); return s },
      onTurnEvent: (ev) => events.push(ev),
    })
    const dispatched = cache.dispatch(11, 'work')
    await new Promise((r) => setTimeout(r, 10))
    const evicted = cache.evictChat(11)
    subs[0].die() // unblock pending send so runNow can finish
    await expect(dispatched).rejects.toThrow()
    await evicted
    expect(events).toHaveLength(1)
    expect(events[0].exitReason).toBe('user_abort')
    await cache.closeAll()
  })
})
