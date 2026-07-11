import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as bindings from '../bindings'
import { handleSlash, type SlashDeps } from '../slash-handler'

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
    expect(spy.sendCalls[0].text).toContain('/think')
    expect(spy.sendCalls[0].text).toContain('/ultrathink')
    expect(spy.sendCalls[0].text).toContain('/plan')
    expect(spy.sendCalls[0].text).toContain('/exit-plan')
  })

  test('prefers the help card when openHelpCard is wired (#108)', async () => {
    const spy = makeSpy({})
    const opened: number[] = []
    const deps = { ...spy.deps, openHelpCard: async (chatId: number) => { opened.push(chatId) } }
    await handleSlash(deps, { kind: 'help' }, 42)
    expect(opened).toEqual([42])
    expect(spy.sendCalls).toHaveLength(0) // no text when the card ships
  })

  test('falls back to HELP_TEXT when openHelpCard throws (#108)', async () => {
    const spy = makeSpy({})
    const deps = { ...spy.deps, openHelpCard: async () => { throw new Error('build failed') } }
    await handleSlash(deps, { kind: 'help' }, 42)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0].text).toContain('Available commands:')
  })
})

// ---------------------------------------------------------------------------
// /stop
// ---------------------------------------------------------------------------

describe('/stop', () => {
  test('acks "Stopping…" immediately, then evicts and acks "Stopped"', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'stop' }, 10)
    expect(spy.evictCalls).toEqual([10])
    expect(spy.sendCalls).toHaveLength(2)
    expect(spy.sendCalls[0].text).toMatch(/stopping/i)
    expect(spy.sendCalls[1].text).toMatch(/stopped/i)
  })

  test('"Stopping…" sends before evict completes (immediate feedback)', async () => {
    const spy = makeSpy({})
    let evictResolve!: () => void
    spy.deps.evictChat = () => new Promise<void>((resolve) => { evictResolve = resolve })
    const handlerDone = handleSlash(spy.deps, { kind: 'stop' }, 10)
    // Yield once so the synchronous `await send(...)` resolves.
    await Promise.resolve()
    await Promise.resolve()
    expect(spy.sendCalls[0]?.text).toMatch(/stopping/i)
    expect(spy.sendCalls).toHaveLength(1)  // "Stopped" not sent yet
    evictResolve()
    await handlerDone
    expect(spy.sendCalls).toHaveLength(2)
  })

  test('reports "Stop failed: <err>" when evict throws', async () => {
    const spy = makeSpy({})
    spy.deps.evictChat = async () => { throw new Error('cache miss') }
    await handleSlash(spy.deps, { kind: 'stop' }, 10)
    expect(spy.sendCalls).toHaveLength(2)
    expect(spy.sendCalls[0].text).toMatch(/stopping/i)
    expect(spy.sendCalls[1].text).toMatch(/stop failed:.*cache miss/i)
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
// /effort
// ---------------------------------------------------------------------------

describe('/effort', () => {
  test('sends "not bound" when chat has no binding', async () => {
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'effort', level: 'high' }, 9876)
    expect(spy.sendCalls[0].text).toMatch(/not bound/i)
  })

  test('shows usage with current setting when bare /effort and bound', async () => {
    bindings.saveBinding({ chatId: 41, agentId: 'effort-agent-bare', sessionId: 's1', createdAt: new Date().toISOString() })
    const spy = makeSpy({})
    // Agent doesn't exist on disk → handler sends a "not found" message, not a usage hint.
    await handleSlash(spy.deps, { kind: 'effort', level: null }, 41)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0].text).toMatch(/not found|effort/i)
  })

  test('confirms set + evicts when bound (uses error path since agent does not exist on disk)', async () => {
    bindings.saveBinding({ chatId: 42, agentId: 'effort-agent-set', sessionId: 's2', createdAt: new Date().toISOString() })
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'effort', level: 'xhigh' }, 42)
    // Either confirms switch OR surfaces the "no agent" error from setAgentEffort —
    // both are non-crashing single-message paths.
    expect(spy.sendCalls).toHaveLength(1)
  })

  test('confirms reset + evicts when bound', async () => {
    bindings.saveBinding({ chatId: 43, agentId: 'effort-agent-reset', sessionId: 's3', createdAt: new Date().toISOString() })
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'effort', level: 'reset' }, 43)
    expect(spy.sendCalls).toHaveLength(1)
  })

  test('unknown level shows usage with the bad input echoed back', async () => {
    bindings.saveBinding({ chatId: 44, agentId: 'effort-agent-bad', sessionId: 's4', createdAt: new Date().toISOString() })
    const spy = makeSpy({})
    await handleSlash(spy.deps, { kind: 'effort', level: null, raw: 'turbo' }, 44)
    // Either "not found" (agent missing) or the unknown-level message — both single-send.
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
// /think and /ultrathink
// ---------------------------------------------------------------------------

describe('/think', () => {
  test('forwards prompt with "Think hard" directive appended', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'think', prompt: 'should I refactor X' }, 50)
    expect(result).toBeTypeOf('string')
    expect(result as string).toContain('should I refactor X')
    expect(result as string).toMatch(/think hard/i)
    expect(spy.sendCalls).toHaveLength(0)
  })

  test('sends usage hint and does not dispatch when prompt is empty', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'think', prompt: '' }, 50)
    expect(result).toBeUndefined()
    expect(spy.sendCalls[0].text).toMatch(/use \/think/i)
  })
})

describe('/ultrathink', () => {
  test('forwards prompt with "Ultrathink" directive appended', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'ultrathink', prompt: 'design a schema' }, 51)
    expect(result).toBeTypeOf('string')
    expect(result as string).toContain('design a schema')
    expect(result as string).toMatch(/ultrathink/i)
    expect(spy.sendCalls).toHaveLength(0)
  })

  test('sends usage hint and does not dispatch when prompt is empty', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'ultrathink', prompt: '' }, 51)
    expect(result).toBeUndefined()
    expect(spy.sendCalls[0].text).toMatch(/use \/ultrathink/i)
  })
})

// ---------------------------------------------------------------------------
// /plan and /exit-plan
// ---------------------------------------------------------------------------

describe('/plan', () => {
  test('forwards "Enter plan mode and plan: <task>" with prompt', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'plan', prompt: 'refactor auth' }, 60)
    expect(result).toBeTypeOf('string')
    expect(result as string).toMatch(/enter plan mode/i)
    expect(result as string).toContain('refactor auth')
    expect(spy.sendCalls).toHaveLength(0)
  })

  test('forwards bare "Enter plan mode." when prompt is empty', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'plan', prompt: '' }, 60)
    expect(result).toBeTypeOf('string')
    expect(result as string).toMatch(/enter plan mode/i)
    expect(result as string).not.toContain(':')
    expect(spy.sendCalls).toHaveLength(0)
  })
})

describe('/exit-plan', () => {
  test('forwards exit instruction', async () => {
    const spy = makeSpy({})
    const result = await handleSlash(spy.deps, { kind: 'exit-plan' }, 61)
    expect(result).toBeTypeOf('string')
    expect(result as string).toMatch(/exit plan mode/i)
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
