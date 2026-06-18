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
      [
        { msgId: 1, chatId: 10, line: '[permissioned] A: keep one', permissioned: true },
        { msgId: 2, chatId: 10, line: '[permissioned] A: drop me', permissioned: true },
      ],
      new Set([2]),
    )
    expect(block).toContain('Earlier context recalled from this chat')
    expect(block).toContain('keep one')
    expect(block).not.toContain('drop me')
  })
  test('empty string when nothing survives dedupe', () => {
    expect(formatMemoryBlock([{ msgId: 2, chatId: 10, line: 'x', permissioned: true }], new Set([2]))).toBe('')
  })
  test('drops unpermissioned snippets from the injected block', () => {
    const block = formatMemoryBlock(
      [
        { msgId: 1, chatId: 10, line: '[permissioned] A: good line', permissioned: true },
        { msgId: 3, chatId: 10, line: '[UNPERMISSIONED] B (ts): [redacted — unpermissioned sender contact 5]', permissioned: false },
      ],
      new Set(),
    )
    expect(block).toContain('good line')
    expect(block).not.toContain('[UNPERMISSIONED]')
    expect(block).not.toContain('redacted')
  })
  test('empty string when only unpermissioned snippets remain after dedupe', () => {
    const block = formatMemoryBlock(
      [{ msgId: 5, chatId: 10, line: '[UNPERMISSIONED] B: [redacted]', permissioned: false }],
      new Set(),
    )
    expect(block).toBe('')
  })
})
