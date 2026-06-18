import { describe, test, expect } from 'bun:test'
import { shouldBoost, formatMemoryBlock } from '../dispatcher/memory-injection'

describe('shouldBoost', () => {
  test('off when disabled for the agent', () => {
    expect(shouldBoost({ enabled: false, stats: { occupancyRatio: 0.9, compactedRecently: true, occupancyTokens: 1 } })).toBe(false)
  })
  test('on right after a compaction', () => {
    expect(shouldBoost({ enabled: true, stats: { occupancyRatio: 0.1, compactedRecently: true, occupancyTokens: 1 } })).toBe(true)
  })
  test('on above the occupancy threshold', () => {
    expect(shouldBoost({ enabled: true, threshold: 0.7, stats: { occupancyRatio: 0.75, compactedRecently: false, occupancyTokens: 1 } })).toBe(true)
  })
  test('off below threshold with no compaction', () => {
    expect(shouldBoost({ enabled: true, threshold: 0.7, stats: { occupancyRatio: 0.5, compactedRecently: false, occupancyTokens: 1 } })).toBe(false)
  })
})

describe('formatMemoryBlock', () => {
  test('labels the block, keeps fresh snippets, dedupes recent-window ids', () => {
    const block = formatMemoryBlock(
      [{ msgId: 1, chatId: 10, line: '[permissioned] A: keep one' }, { msgId: 2, chatId: 10, line: '[permissioned] A: drop me' }],
      new Set([2]),
    )
    expect(block).toContain('Earlier context recalled from this chat')
    expect(block).toContain('keep one')
    expect(block).not.toContain('drop me')
  })
  test('empty string when nothing survives dedupe', () => {
    expect(formatMemoryBlock([{ msgId: 2, chatId: 10, line: 'x' }], new Set([2]))).toBe('')
  })
})
