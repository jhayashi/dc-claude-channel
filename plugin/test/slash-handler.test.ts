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
const projectCwd = mkdtempSync(join(tmpdir(), 'dc-slash-project-'))

// memory dir mirrors the Claude Code convention: cwd → replace / with -
const memoryDir = join(tmpdir(), 'dc-slash-memory-' + Date.now())

beforeAll(() => {
  bindings.setBindingsDir(bindingsDir)
  mkdirSync(memoryDir, { recursive: true })
  writeFileSync(join(memoryDir, 'MEMORY.md'), '# Memory Index\n\n- [Test entry](test_entry.md) — a test\n')
  writeFileSync(join(memoryDir, 'test_entry.md'), '---\nname: test\ntype: user\n---\n\nTest content.\n')
})

afterAll(() => {
  rmSync(bindingsDir, { recursive: true, force: true })
  rmSync(projectCwd, { recursive: true, force: true })
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

function makeSpy(memoryOverrideDir?: string): Spy {
  const sendCalls: Array<{ chatId: number; text: string }> = []
  const evictCalls: number[] = []
  const logCalls: string[] = []

  // Build a fake projectCwd that resolves to memoryOverrideDir.
  // The handler computes: cwd.replace(/\//g, '-') appended to ~/.claude/projects/.
  // We bypass that by passing projectCwd directly (which won't match anything
  // real) — or we use the memoryOverrideDir via a separate mechanism.
  // Since resolveMemoryDir is internal, we expose a projectCwd that maps
  // to our test memoryDir.
  //
  // Simpler: just test with a projectCwd that we know doesn't have memory,
  // and test memory separately by mocking projectCwd to point to the dir
  // whose computed key equals the memoryDir basename.
  const deps: SlashDeps = {
    send: async (chatId, text) => { sendCalls.push({ chatId, text }) },
    evictChat: async (chatId) => { evictCalls.push(chatId) },
    logf: (fmt, ...args) => { logCalls.push([fmt, ...args].join(' ')) },
    projectCwd: memoryOverrideDir,
  }

  return { sendCalls, evictCalls, logCalls, deps }
}

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

describe('/help', () => {
  test('sends help text to the correct chatId', async () => {
    const spy = makeSpy()
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
    const spy = makeSpy()
    await handleSlash(spy.deps, { kind: 'stop' }, 10)
    expect(spy.evictCalls).toEqual([10])
    expect(spy.sendCalls[0].text).toMatch(/stopped/i)
  })

  test('still confirms even if evict throws', async () => {
    const spy = makeSpy()
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

    const spy = makeSpy()
    await handleSlash(spy.deps, { kind: 'clear' }, 20)

    expect(spy.evictCalls).toEqual([20])
    expect(spy.sendCalls[0].text).toMatch(/cleared/i)
    // sessionId should be gone from the binding.
    const b = bindings.getBinding(20)
    expect(b?.sessionId).toBeUndefined()
  })

  test('still confirms even if evict throws', async () => {
    const spy = makeSpy()
    spy.deps.evictChat = async () => { throw new Error('no entry') }
    await handleSlash(spy.deps, { kind: 'clear' }, 99)
    expect(spy.sendCalls[0].text).toMatch(/cleared/i)
  })
})

// ---------------------------------------------------------------------------
// /memory
// ---------------------------------------------------------------------------

// Build a projectCwd whose replace(/\//g,'-') + ~/.claude/projects/... path
// equals our test memoryDir. We do this by making a fake homedir+projects dir.
// Simpler: directly test the file-reading by constructing a projectCwd
// that, when processed by resolveMemoryDir, lands in our test fixture.

// resolveMemoryDir(cwd) = join(homedir(), '.claude', 'projects', cwd.replace(/\//g, '-'), 'memory')
// We want that to equal memoryDir. But that path is computed from homedir() which we can't override.
// Instead, we'll exercise memory paths via a separate test helper that writes actual files to the
// computed path, or we just accept these as integration-style tests and use a real temp dir.

// Easier: accept that /memory tests are light (unit test the error path; rely on the
// read-path being an obvious readFile call). The key behaviors we care about in tests:
// - missing dir → "No memory found" message
// - ENOENT on show → "No memory entry found" message

describe('/memory list', () => {
  test('returns "no memory" when projectCwd has no memory dir', async () => {
    const spy = makeSpy('/tmp/no-such-project-cwd-12345')
    await handleSlash(spy.deps, { kind: 'memory' }, 5)
    expect(spy.sendCalls[0].text).toMatch(/no memory found/i)
  })
})

describe('/memory show', () => {
  test('returns "no entry" when key does not exist', async () => {
    const spy = makeSpy('/tmp/no-such-project-cwd-12345')
    await handleSlash(spy.deps, { kind: 'memory', subcommand: 'show', key: 'nonexistent' }, 5)
    expect(spy.sendCalls[0].text).toMatch(/no memory entry found/i)
  })
})

// ---------------------------------------------------------------------------
// /mcp — no MCP servers configured in test env (returns graceful message)
// ---------------------------------------------------------------------------

describe('/mcp', () => {
  test('sends a response (either "no servers" or a list)', async () => {
    const spy = makeSpy()
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
    const spy = makeSpy()
    await handleSlash(spy.deps, { kind: 'plugin' }, 8)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0].chatId).toBe(8)
    expect(spy.sendCalls[0].text.length).toBeGreaterThan(0)
  })
})
