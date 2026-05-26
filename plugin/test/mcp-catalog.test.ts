import { describe, test, expect } from 'bun:test'
import {
  prefixToDisplayName,
  displayNameToPrefix,
  buildCatalog,
  getAvailableMcpServers,
  getConnectedMcpServers,
  type CatalogSources,
} from '../mcp-catalog'

const base: CatalogSources = {
  curatedClaudeAi: ['claude_ai_Gmail', 'claude_ai_Google_Calendar', 'claude_ai_Google_Drive'],
  needsAuthDisplayNames: new Set<string>(),
  configuredServers: [],
}

describe('prefixToDisplayName', () => {
  test('claude_ai_Gmail → claude.ai Gmail', () => {
    expect(prefixToDisplayName('claude_ai_Gmail')).toBe('claude.ai Gmail')
  })
  test('multi-word suffix', () => {
    expect(prefixToDisplayName('claude_ai_Google_Drive')).toBe('claude.ai Google Drive')
  })
  test('null for non-claude_ai', () => {
    expect(prefixToDisplayName('dc')).toBeNull()
    expect(prefixToDisplayName('plugin_telegram_telegram')).toBeNull()
  })
})

describe('displayNameToPrefix', () => {
  test('round-trips with prefixToDisplayName', () => {
    expect(displayNameToPrefix('claude.ai Google Drive')).toBe('claude_ai_Google_Drive')
    expect(displayNameToPrefix('claude.ai Gmail')).toBe('claude_ai_Gmail')
  })
  test('null for non-claude.ai names', () => {
    expect(displayNameToPrefix('Some Local Server')).toBeNull()
  })
})

describe('buildCatalog', () => {
  test('dc is always present and connected', () => {
    const dc = buildCatalog(base).find(s => s.prefix === 'dc')
    expect(dc).toBeDefined()
    expect(dc!.connected).toBe(true)
    expect(dc!.label).toBe('DC Tools')
  })

  test('curated claude.ai servers are shown; connected when not awaiting auth', () => {
    const cat = buildCatalog(base)
    const gmail = cat.find(s => s.prefix === 'claude_ai_Gmail')
    expect(gmail).toBeDefined()
    expect(gmail!.connected).toBe(true)
    expect(gmail!.label).toBe('Gmail')
  })

  test('a curated server in the needs-auth cache is not connected', () => {
    const cat = buildCatalog({ ...base, needsAuthDisplayNames: new Set(['claude.ai Gmail']) })
    expect(cat.find(s => s.prefix === 'claude_ai_Gmail')!.connected).toBe(false)
    // others stay connected
    expect(cat.find(s => s.prefix === 'claude_ai_Google_Calendar')!.connected).toBe(true)
  })

  test('a needs-auth-only server (not curated) is surfaced as not connected', () => {
    const cat = buildCatalog({ ...base, needsAuthDisplayNames: new Set(['claude.ai Spotify']) })
    const spotify = cat.find(s => s.prefix === 'claude_ai_Spotify')
    expect(spotify).toBeDefined()
    expect(spotify!.connected).toBe(false)
    expect(spotify!.label).toBe('Spotify') // derived label
  })

  test('configured user server: connected iff not disabled', () => {
    const cat = buildCatalog({
      ...base,
      configuredServers: [
        { prefix: 'my-local', disabled: false },
        { prefix: 'off-server', disabled: true },
      ],
    })
    expect(cat.find(s => s.prefix === 'my-local')!.connected).toBe(true)
    expect(cat.find(s => s.prefix === 'off-server')!.connected).toBe(false)
  })

  test('dedup by prefix (curated wins over a duplicate configured entry)', () => {
    const cat = buildCatalog({
      ...base,
      configuredServers: [{ prefix: 'claude_ai_Gmail', disabled: true }],
    })
    expect(cat.filter(s => s.prefix === 'claude_ai_Gmail')).toHaveLength(1)
    // curated entry's connected status (true, not awaiting auth) is kept
    expect(cat.find(s => s.prefix === 'claude_ai_Gmail')!.connected).toBe(true)
  })
})

// fs-invariant smoke tests for the wrappers (hold regardless of ~/.claude state).
describe('getAvailableMcpServers', () => {
  test('annotates only the dc entry with toolCount', () => {
    const servers = getAvailableMcpServers(42)
    const dc = servers.find(s => s.prefix === 'dc')
    expect(dc).toBeDefined()
    expect(dc!.toolCount).toBe(42)
    for (const s of servers) {
      if (s.prefix !== 'dc') expect(s.toolCount).toBeUndefined()
    }
  })
})

describe('getConnectedMcpServers', () => {
  test('always includes dc', () => {
    expect(getConnectedMcpServers()).toContain('dc')
  })
})
