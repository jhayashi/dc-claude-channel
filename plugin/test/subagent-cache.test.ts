import { describe, it, expect } from 'bun:test'
import { SubagentCache, type SubagentLike } from '../dispatcher/subagent-cache.js'

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
