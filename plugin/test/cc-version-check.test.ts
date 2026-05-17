import { describe, test, expect } from 'bun:test'
import {
  parseClaudeVersion,
  isVersionAtLeast,
  MINIMUM_CLAUDE_VERSION,
} from '../cc-version-check'

describe('parseClaudeVersion', () => {
  test('parses standard "2.1.100" output', () => {
    expect(parseClaudeVersion('2.1.100\n')).toEqual([2, 1, 100])
  })

  test('parses output with "Claude Code" prefix', () => {
    expect(parseClaudeVersion('Claude Code 2.1.100')).toEqual([2, 1, 100])
  })

  test('parses output with leading whitespace', () => {
    expect(parseClaudeVersion('  2.0.5\n')).toEqual([2, 0, 5])
  })

  test('returns null on unparseable output', () => {
    expect(parseClaudeVersion('not a version')).toBeNull()
    expect(parseClaudeVersion('')).toBeNull()
  })

  test('handles pre-release suffixes by dropping them', () => {
    expect(parseClaudeVersion('2.1.100-beta.3')).toEqual([2, 1, 100])
  })
})

describe('isVersionAtLeast', () => {
  test('major bump qualifies', () => {
    expect(isVersionAtLeast([3, 0, 0], [2, 1, 100])).toBe(true)
  })
  test('minor bump qualifies', () => {
    expect(isVersionAtLeast([2, 2, 0], [2, 1, 100])).toBe(true)
  })
  test('patch bump qualifies', () => {
    expect(isVersionAtLeast([2, 1, 101], [2, 1, 100])).toBe(true)
  })
  test('exact match qualifies', () => {
    expect(isVersionAtLeast([2, 1, 100], [2, 1, 100])).toBe(true)
  })
  test('older patch fails', () => {
    expect(isVersionAtLeast([2, 1, 99], [2, 1, 100])).toBe(false)
  })
  test('older minor fails', () => {
    expect(isVersionAtLeast([2, 0, 999], [2, 1, 100])).toBe(false)
  })
  test('older major fails', () => {
    expect(isVersionAtLeast([1, 9, 9], [2, 1, 100])).toBe(false)
  })
})

describe('MINIMUM_CLAUDE_VERSION', () => {
  test('is a [major, minor, patch] tuple', () => {
    expect(MINIMUM_CLAUDE_VERSION).toHaveLength(3)
    for (const part of MINIMUM_CLAUDE_VERSION) {
      expect(typeof part).toBe('number')
      expect(part).toBeGreaterThanOrEqual(0)
    }
  })
})
