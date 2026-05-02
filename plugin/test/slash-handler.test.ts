import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as bindings from '../bindings'
import { handleSlash, formatUsage, formatTokenCount, type SlashDeps, type StatsCache } from '../slash-handler'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const bindingsDir = mkdtempSync(join(tmpdir(), 'dc-slash-bindings-'))
const memoryDir = join(tmpdir(), 'dc-slash-memory-' + Date.now())

beforeAll(() => {
  bindings.setBindingsDir(bindingsDir)
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n\n- [Test entry](test_entry.md) — a test\n')
  writeFileSync(join(memoryDir, 'test_entry.md'), '---\nname: test\ntype: user\n---\n\nTest content.\n')
})

afterAll(() => {
  rmSync(bindingsDir, { recursive: true, force: true })
  rmSync(memoryDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Spy factory
// ---------------------------------------------------------------------------

interface Spy {
  sendCalls: Array<{ chatId: number; text: string }>
  evictCalls: number[]
  logCalls: string[]
  deps: SlashDeps
}

function makeSpy(opts: { memoryDirOverride?: string } = {}): Spy {
  const sendCalls: Array<{ chatId: number; text: string }> = []
  const evictCalls: number[] = []
  const logCalls: string[] = []

  const deps: SlashDeps = {
    send: async (chatId, text) => { sendCalls.push({ chatId, text }) },
    evictChat: async (chatId) => { evictCalls.push(chatId) },
    logf: (fmt, ...args) => { logCalls.push([fmt, ...args].join(' ')) },
    memoryDirOverride: opts.memoryDirOverride,
  }

  return { sendCalls, evictCalls, logCalls, deps }
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

describe('/help', () => {
  test('sends help text to the correct chatId', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'help' }, 42)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0].chatId).toBe(42)
    expect(spy.sendCalls[0].text).toContain('/stop')
    expect(spy.sendCalls[0].text).toContain('/clear')
    expect(spy.sendCalls[0].text).toContain('/memory')
    expect(spy.sendCalls[0].text).toContain('/mcp')
    expect(spy.sendCalls[0].text).toContain('/plugin')
  })
})

// ---------------------------------------------------------------------------
// /stop
// ---------------------------------------------------------------------------

describe('/stop', () => {
  test('evicts subagent and confirms', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'stop' }, 10)
    expect(spy.evictCalls).toEqual([10])
    expect(spy.sendCalls[0].text).toMatch(/stopped/i)
  })

  test('still confirms even if evict throws', async () => {
    const spy = makeSpy({})
    spy.deps.evictChat = async () => { throw new Error('cache miss') }
    await handleSlash(spy.deps, { kind: 'stop' }, 10)
    expect(spy.sendCalls[0].text).toMatch(/stopped/i)
    expect(spy.logCalls.some((l) => l.includes('evict failed'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// /clear
// ---------------------------------------------------------------------------

describe('/clear', () => {
  test('evicts subagent, clears sessionId, and confirms', async () => {
    // Create a binding with a sessionId to clear.
    bindings.saveBinding({ chatId: 20, agentId: 'test-agent', sessionId: 'sess-abc', createdAt: new Date().toISOString() })

    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'clear' }, 20)

    expect(spy.evictCalls).toEqual([20])
    expect(spy.sendCalls[0].text).toMatch(/cleared/i)
    // sessionId should be gone from the binding.
    const b = bindings.getBinding(20)
    expect(b?.sessionId).toBeUndefined()
  })

  test('still confirms even if evict throws', async () => {
    const spy = makeSpy({})
    spy.deps.evictChat = async () => { throw new Error('no entry') }
    await handleSlash(spy.deps, { kind: 'clear' }, 99)
    expect(spy.sendCalls[0].text).toMatch(/cleared/i)
  })
})

// ---------------------------------------------------------------------------
// /memory
// ---------------------------------------------------------------------------

describe('/memory list', () => {
  test('returns MEMORY.md content when dir exists', async () => {
    const spy = makeSpy({ memoryDirOverride: memoryDir })
    await handleSlash(spy.deps, { kind: 'memory' }, 5)
    expect(spy.sendCalls[0].text).toContain('Memory Index')
    expect(spy.sendCalls[0].text).toContain('test_entry.md')
  })

  test('returns "no memory" when dir does not exist', async () => {
    const spy = makeSpy({ memoryDirOverride: '/tmp/no-such-memory-dir-12345' })
    await handleSlash(spy.deps, { kind: 'memory' }, 5)
    expect(spy.sendCalls[0].text).toMatch(/no memory found/i)
  })
})

describe('/memory show', () => {
  test('returns file content for a valid key', async () => {
    const spy = makeSpy({ memoryDirOverride: memoryDir })
    await handleSlash(spy.deps, { kind: 'memory', subcommand: 'show', key: 'test_entry' }, 5)
    expect(spy.sendCalls[0].text).toContain('Test content.')
  })

  test('accepts key with .md suffix', async () => {
    const spy = makeSpy({ memoryDirOverride: memoryDir })
    await handleSlash(spy.deps, { kind: 'memory', subcommand: 'show', key: 'test_entry.md' }, 5)
    expect(spy.sendCalls[0].text).toContain('Test content.')
  })

  test('returns "no entry" when key does not exist', async () => {
    const spy = makeSpy({ memoryDirOverride: memoryDir })
    await handleSlash(spy.deps, { kind: 'memory', subcommand: 'show', key: 'nonexistent' }, 5)
    expect(spy.sendCalls[0].text).toMatch(/no memory entry found/i)
  })

  test('rejects path traversal attempts', async () => {
    const spy = makeSpy({ memoryDirOverride: memoryDir })
    await handleSlash(spy.deps, { kind: 'memory', subcommand: 'show', key: '../../settings.json' }, 5)
    expect(spy.sendCalls[0].text).toMatch(/invalid memory key/i)
  })
})

// ---------------------------------------------------------------------------
// /mcp — no MCP servers configured in test env (returns graceful message)
// ---------------------------------------------------------------------------

describe('/mcp', () => {
  test('sends a response (either "no servers" or a list)', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'mcp' }, 7)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0].chatId).toBe(7)
    expect(spy.sendCalls[0].text.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// /plugin
// ---------------------------------------------------------------------------

describe('/plugin', () => {
  test('sends a response (either "no plugins" or a list)', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'plugin' }, 8)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0].chatId).toBe(8)
    expect(spy.sendCalls[0].text.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// /model
// ---------------------------------------------------------------------------

describe('/model', () => {
  test('sends usage hint when tier is null', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'model', tier: null }, 9)
    expect(spy.sendCalls[0].text).toMatch(/usage/i)
  })

  test('sends "not bound" when chat has no binding', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'model', tier: 'opus' }, 999)
    expect(spy.sendCalls[0].text).toMatch(/not bound/i)
  })

  test('confirms switch when bound', async () => {
    bindings.saveBinding({ chatId: 30, agentId: 'test-agent', sessionId: 'sess-xyz', createdAt: new Date().toISOString() })
    const spy = makeSpy({})
    // setAgentModel will throw because 'test-agent' doesn't exist on disk in test env
    // — we just verify the error path sends a message instead of crashing.
    await handleSlash(spy.deps, { kind: 'model', tier: 'sonnet' }, 30)
    expect(spy.sendCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// /compact
// ---------------------------------------------------------------------------

describe('/compact', () => {
  test('returns rewritten prose for subagent dispatch', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'compact' }, 11)
    expect(result).toBeTypeOf('string')
    expect(result).toMatch(/compact/i)
    expect(spy.sendCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// /usage
// ---------------------------------------------------------------------------

describe('/usage', () => {
  test('sends a response (either "no usage data" or formatted stats)', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'usage' }, 12)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0].text.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// /blocked
// ---------------------------------------------------------------------------

describe('/blocked', () => {
  test('sends "not available" and returns void', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'blocked', cmd: 'loop' }, 13)
    expect(result).toBeUndefined()
    expect(spy.sendCalls[0].text).toMatch(/loop.*isn't available/i)
  })
})

// ---------------------------------------------------------------------------
// /unknown-slash (pass-through)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe('formatTokenCount', () => {
  test.each<[number, string]>([
    [0, '0'],
    [999, '999'],
    [1_000, '1K'],
    [1_500, '2K'],
    [1_000_000, '1.0M'],
    [1_234_567, '1.2M'],
    [1_000_000_000, '1.0B'],
    [5_700_000_000, '5.7B'],
  ])('%d → %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// formatUsage
// ---------------------------------------------------------------------------

describe('formatUsage', () => {
  test('shows "unknown" when lastComputedDate is absent', () => {
    const stats: StatsCache = {}
    expect(formatUsage(stats)).toContain('unknown')
  })

  test('includes lastComputedDate in header', () => {
    const stats: StatsCache = { lastComputedDate: '2026-05-01' }
    expect(formatUsage(stats)).toContain('2026-05-01')
  })

  test('formats model token totals', () => {
    const stats: StatsCache = {
      lastComputedDate: '2026-05-01',
      modelUsage: {
        'claude-opus-4-6': { inputTokens: 100_000, outputTokens: 200_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    }
    const out = formatUsage(stats)
    expect(out).toContain('opus-4-6')
    expect(out).toContain('300K')
  })

  test('strips date suffix from model name', () => {
    const stats: StatsCache = {
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000, cacheCreationInputTokens: 0 },
      },
    }
    const out = formatUsage(stats)
    expect(out).toContain('haiku-4-5')
    expect(out).not.toContain('20251001')
  })

  test('shows totalMessages and totalSessions when present', () => {
    const stats: StatsCache = { totalMessages: 12345, totalSessions: 67 }
    const out = formatUsage(stats)
    expect(out).toContain('12,345')
    expect(out).toContain('67')
  })

  test('omits totals section when both are absent', () => {
    const stats: StatsCache = { lastComputedDate: '2026-05-01' }
    const out = formatUsage(stats)
    expect(out).not.toContain('Total messages')
    expect(out).not.toContain('Total sessions')
  })
})

// ---------------------------------------------------------------------------

describe('/unknown-slash', () => {
  test('returns rewritten prose with args', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'unknown-slash', cmd: 'review', args: 'the auth module' }, 14)
    expect(result).toBeTypeOf('string')
    expect(result as string).toContain('/review')
    expect(result as string).toContain('the auth module')
    expect(spy.sendCalls).toHaveLength(0)
  })

  test('returns rewritten prose without args', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'unknown-slash', cmd: 'brainstorm', args: '' }, 15)
    expect(result).toBeTypeOf('string')
    expect(result as string).toContain('/brainstorm')
  })
})
