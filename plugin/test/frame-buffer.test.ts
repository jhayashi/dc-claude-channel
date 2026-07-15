import { describe, test, expect } from 'bun:test'
import { FrameBuffer } from '../dispatcher/frame-buffer'

type Frame = { type: string; subtype?: string; result?: string }
const isResult = (f: Frame) =>
  f.type === 'result' && (f.subtype === 'success' || f.subtype === 'error_during_execution')

describe('FrameBuffer', () => {
  test('read resolves with a matching frame that arrives after read starts', async () => {
    const fb = new FrameBuffer<Frame>()
    const p = fb.read(isResult, 1000)
    fb.push({ type: 'assistant' }) // non-matching, buffered
    fb.push({ type: 'result', subtype: 'success', result: 'A' })
    expect((await p).result).toBe('A')
  })

  test('read resolves with a matching frame already buffered when read starts (intra-turn timing)', async () => {
    const fb = new FrameBuffer<Frame>()
    fb.push({ type: 'result', subtype: 'success', result: 'A' })
    expect((await fb.read(isResult, 1000)).result).toBe('A')
  })

  test('read rejects on timeout when no matching frame arrives', async () => {
    const fb = new FrameBuffer<Frame>()
    await expect(fb.read(isResult, 20)).rejects.toThrow(/timeout after 20ms/)
  })

  // Regression for the off-by-one / stale-frame misdelivery bug: a result frame
  // left buffered by a prior (timed-out or otherwise abandoned) turn must NOT be
  // handed to the next turn. clearStale() drops leftovers at turn start.
  test('a result buffered before a turn is discarded by clearStale, not delivered to the next turn', async () => {
    const fb = new FrameBuffer<Frame>()
    // Stale result left over from a prior turn whose reader already went away:
    fb.push({ type: 'result', subtype: 'success', result: 'STALE' })

    // New turn begins — drop anything lingering from before:
    const dropped = fb.clearStale()
    expect(dropped).toBe(1)

    // This turn reads its own result:
    const p = fb.read(isResult, 1000)
    fb.push({ type: 'result', subtype: 'success', result: 'FRESH' })
    expect((await p).result).toBe('FRESH')
  })

  test('clearStale also drops buffered non-result frames (no unbounded growth)', () => {
    const fb = new FrameBuffer<Frame>()
    fb.push({ type: 'assistant' })
    fb.push({ type: 'assistant' })
    fb.push({ type: 'result', subtype: 'success', result: 'X' })
    expect(fb.clearStale()).toBe(3)
    expect(fb.clearStale()).toBe(0)
  })
})
