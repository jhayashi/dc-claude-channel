import { describe, test, expect } from 'bun:test'
import { filterConnectedPrefixes, mcpPrefixToAuthCacheKey } from '../server'

describe('mcpPrefixToAuthCacheKey', () => {
  test('converts claude_ai_Gmail to claude.ai Gmail', () => {
    expect(mcpPrefixToAuthCacheKey('claude_ai_Gmail')).toBe('claude.ai Gmail')
  })

  test('converts multi-word suffix with underscores', () => {
    expect(mcpPrefixToAuthCacheKey('claude_ai_Google_Calendar')).toBe('claude.ai Google Calendar')
    expect(mcpPrefixToAuthCacheKey('claude_ai_Google_Drive')).toBe('claude.ai Google Drive')
  })

  test('returns null for non-claude_ai prefixes', () => {
    expect(mcpPrefixToAuthCacheKey('dc')).toBeNull()
    expect(mcpPrefixToAuthCacheKey('plugin_telegram_telegram')).toBeNull()
  })
})

describe('filterConnectedPrefixes', () => {
  test('empty needsAuth set — all known servers are connected', () => {
    const connected = filterConnectedPrefixes(new Set())
    expect(connected).toContain('dc')
    expect(connected).toContain('claude_ai_Gmail')
    expect(connected).toContain('claude_ai_Google_Calendar')
  })

  test('excludes servers listed in needsAuth', () => {
    const connected = filterConnectedPrefixes(new Set(['claude.ai Gmail', 'claude.ai Slack']))
    expect(connected).toContain('dc')
    expect(connected).not.toContain('claude_ai_Gmail')
    expect(connected).not.toContain('claude_ai_Slack')
    expect(connected).toContain('claude_ai_Google_Calendar')
  })

  test('dc server is always connected regardless of needsAuth', () => {
    const connected = filterConnectedPrefixes(new Set(['claude.ai Gmail']))
    expect(connected).toContain('dc')
  })

  test('non-claude_ai servers are always connected', () => {
    const connected = filterConnectedPrefixes(new Set())
    expect(connected).toContain('plugin_telegram_telegram')
  })
})
