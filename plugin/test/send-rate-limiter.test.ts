import { describe, test, expect } from 'bun:test'
import { createSendRateLimiter } from '../dispatcher/send-rate-limiter'

// Tests use real timers with small refill intervals so the suite stays fast
// (< 2s total). All timing assertions allow generous slack for setTimeout
// scheduling jitter.

function makeLogger(): { logs: string[]; logf: (msg: string) => void } {
  const logs: string[] = []
  return { logs, logf: (msg) => logs.push(msg) }
}

describe('createSendRateLimiter', () => {
  test('passes immediately when bucket has tokens', async () => {
    const lim = createSendRateLimiter({ capacity: 3, refillPerSec: 1 })
    const start = Date.now()
    await lim.acquire()
    expect(Date.now() - start).toBeLessThan(15)
    expect(lim.inspect().tokens).toBeLessThan(3)
  })

  test('serializes burst of capacity without parking', async () => {
    const lim = createSendRateLimiter({ capacity: 5, refillPerSec: 1 })
    const start = Date.now()
    await Promise.all([
      lim.acquire(), lim.acquire(), lim.acquire(), lim.acquire(), lim.acquire(),
    ])
    expect(Date.now() - start).toBeLessThan(30)
  })

  test('parks burst over capacity', async () => {
    // 1 token per 50ms refill, capacity 2 → 3rd acquire waits ~50ms
    const lim = createSendRateLimiter({ capacity: 2, refillPerSec: 20 })
    const start = Date.now()
    await Promise.all([lim.acquire(), lim.acquire(), lim.acquire()])
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(40)
    expect(elapsed).toBeLessThan(200)
  })

  test('paces sustained load at refill rate', async () => {
    // capacity=2, refill=20/s (50ms each). 6 acquires: first 2 fast, next 4 paced
    const lim = createSendRateLimiter({ capacity: 2, refillPerSec: 20 })
    const start = Date.now()
    const promises: Promise<void>[] = []
    for (let i = 0; i < 6; i++) promises.push(lim.acquire())
    await Promise.all(promises)
    const elapsed = Date.now() - start
    // 4 paced * 50ms = ~200ms minimum
    expect(elapsed).toBeGreaterThanOrEqual(180)
    expect(elapsed).toBeLessThan(500)
  })

  test('preserves FIFO order across concurrent acquires', async () => {
    const lim = createSendRateLimiter({ capacity: 1, refillPerSec: 50 })
    const order: number[] = []
    const promises: Promise<void>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(lim.acquire().then(() => order.push(i)))
    }
    await Promise.all(promises)
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('disabled limiter is pass-through', async () => {
    const lim = createSendRateLimiter({ capacity: 1, refillPerSec: 1, enabled: false })
    const start = Date.now()
    // Even with capacity 1 and refill 1/s, 50 acquires must all resolve fast
    await Promise.all(Array.from({ length: 50 }, () => lim.acquire()))
    expect(Date.now() - start).toBeLessThan(50)
  })

  test('inspect reports state', async () => {
    const lim = createSendRateLimiter({ capacity: 4, refillPerSec: 10 })
    expect(lim.inspect().capacity).toBe(4)
    expect(lim.inspect().refillPerSec).toBe(10)
    expect(lim.inspect().queued).toBe(0)
    await lim.acquire()
    expect(lim.inspect().tokens).toBeLessThan(4)
  })

  test('inspect shows queued count when bucket is empty', async () => {
    const lim = createSendRateLimiter({ capacity: 1, refillPerSec: 5 })
    await lim.acquire() // drain to 0
    const p1 = lim.acquire()
    const p2 = lim.acquire()
    // Allow microtasks to flush the queueing
    await Promise.resolve()
    expect(lim.inspect().queued).toBeGreaterThanOrEqual(1)
    await Promise.all([p1, p2])
    expect(lim.inspect().queued).toBe(0)
  })

  test('clamps invalid capacity and refillPerSec', () => {
    const { logs, logf } = makeLogger()
    const lim = createSendRateLimiter({ capacity: 0, refillPerSec: 0, logf })
    const state = lim.inspect()
    expect(state.capacity).toBe(1) // clamped up
    expect(state.refillPerSec).toBeGreaterThan(0)
    expect(logs.length).toBeGreaterThan(0)
    expect(logs[0]).toContain('clamped')
  })

  test('clamps capacity above 100', () => {
    const lim = createSendRateLimiter({ capacity: 1000, refillPerSec: 1 })
    expect(lim.inspect().capacity).toBe(100)
  })

  test('does not refund token on caller throw downstream', async () => {
    const lim = createSendRateLimiter({ capacity: 2, refillPerSec: 1 })
    const before = lim.inspect().tokens
    await lim.acquire()
    // Simulate caller's RPC throwing AFTER our acquire resolves
    try {
      await lim.acquire()
      throw new Error('boom from caller')
    } catch {
      // ignore
    }
    const after = lim.inspect().tokens
    expect(after).toBeLessThanOrEqual(before - 2)
  })

  test('handles 50 parked acquires without leak', async () => {
    const lim = createSendRateLimiter({ capacity: 5, refillPerSec: 100 }) // 10ms each
    const start = Date.now()
    const resolved: number[] = []
    const promises: Promise<void>[] = []
    for (let i = 0; i < 50; i++) {
      promises.push(lim.acquire().then(() => resolved.push(i)))
    }
    await Promise.all(promises)
    expect(resolved.length).toBe(50)
    expect(resolved).toEqual(Array.from({ length: 50 }, (_, i) => i))
    // 5 free + 45 paced * 10ms = ~450ms. Allow generous slack.
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(1500)
  })

  test('queue drains correctly after a long idle', async () => {
    const lim = createSendRateLimiter({ capacity: 2, refillPerSec: 50 }) // 20ms refill
    await lim.acquire()
    await lim.acquire() // drain to 0
    // Wait for refill
    await new Promise((r) => setTimeout(r, 100))
    // Should now have ~2 tokens (capped)
    const state = lim.inspect()
    expect(state.tokens).toBeGreaterThanOrEqual(1)
    // Next acquire should be fast
    const start = Date.now()
    await lim.acquire()
    expect(Date.now() - start).toBeLessThan(15)
  })

  test('logs first park but not every park', async () => {
    const { logs, logf } = makeLogger()
    const lim = createSendRateLimiter({ capacity: 1, refillPerSec: 100, logf }) // 10ms refill
    await lim.acquire() // drain to 0
    // Fire 5 acquires — at most 3 should be logged per the limiter's policy
    await Promise.all([
      lim.acquire(), lim.acquire(), lim.acquire(), lim.acquire(), lim.acquire(),
    ])
    // Filter to 'parking' lines only (clamp warning may also be present)
    const parkLogs = logs.filter((l) => l.includes('parking'))
    expect(parkLogs.length).toBeLessThanOrEqual(3)
    expect(parkLogs.length).toBeGreaterThanOrEqual(1)
  })
})
