import { describe, test, expect } from 'bun:test'
import { analyzeTranscriptTail } from '../dispatcher/session-context-stats'

const real = (input: number, cacheRead: number) => JSON.stringify({
  type: 'assistant', timestamp: '2026-06-17T00:00:00Z', sessionId: 's',
  message: { model: 'claude-opus-4-8', usage: { input_tokens: input, cache_read_input_tokens: cacheRead } },
})
const synthetic = JSON.stringify({
  type: 'assistant', timestamp: '2026-06-17T00:00:01Z', sessionId: 's',
  message: { model: '<synthetic>', usage: {} },
})

describe('analyzeTranscriptTail', () => {
  test('occupancy from the last real assistant turn (input + cache_read)', () => {
    const r = analyzeTranscriptTail(real(2000, 50000), { windowTokens: 200000 })
    expect(r.occupancyTokens).toBe(52000)
    expect(r.occupancyRatio).toBeCloseTo(0.26, 2)
    expect(r.compactedRecently).toBe(false)
  })
  test('detects a recent compaction (synthetic line in the tail)', () => {
    const r = analyzeTranscriptTail([real(2000, 50000), synthetic].join('\n'), { windowTokens: 200000 })
    expect(r.compactedRecently).toBe(true)
  })
  test('empty / unparseable → zero occupancy, no compaction', () => {
    const r = analyzeTranscriptTail('', { windowTokens: 200000 })
    expect(r.occupancyTokens).toBe(0)
    expect(r.compactedRecently).toBe(false)
  })
})
