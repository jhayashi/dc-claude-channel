import { describe, test, expect } from 'bun:test'

/**
 * Documents the per-msgId serialization contract used in server.ts.
 * If the pattern in server.ts changes, update this test.
 */
describe('per-msgId handler serialization', () => {
  const dispatch = (chain: Map<number, Promise<void>>, msgId: number, work: () => Promise<void>): Promise<void> => {
    const prev = chain.get(msgId) ?? Promise.resolve()
    const next = prev.then(work).catch(() => {})
    chain.set(msgId, next)
    return next
  }

  test('two overlapping calls for same msgId run serially', async () => {
    const chain = new Map<number, Promise<void>>()
    const timeline: string[] = []
    const workA = async () => {
      timeline.push('A-start')
      await new Promise(r => setTimeout(r, 50))
      timeline.push('A-end')
    }
    const workB = async () => {
      timeline.push('B-start')
      await new Promise(r => setTimeout(r, 10))
      timeline.push('B-end')
    }
    await Promise.all([dispatch(chain, 1, workA), dispatch(chain, 1, workB)])
    expect(timeline).toEqual(['A-start', 'A-end', 'B-start', 'B-end'])
  })

  test('different msgIds run concurrently', async () => {
    const chain = new Map<number, Promise<void>>()
    const timeline: string[] = []
    const workA = async () => {
      timeline.push('A-start')
      await new Promise(r => setTimeout(r, 50))
      timeline.push('A-end')
    }
    const workB = async () => {
      timeline.push('B-start')
      await new Promise(r => setTimeout(r, 10))
      timeline.push('B-end')
    }
    await Promise.all([dispatch(chain, 1, workA), dispatch(chain, 2, workB)])
    expect(timeline.indexOf('B-end')).toBeLessThan(timeline.indexOf('A-end'))
  })
})
