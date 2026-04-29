import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as agents from '../agents'
import * as bindings from '../bindings'
import { handleNlIntent, type NlIntentDeps } from '../nl-intent-handler'

const agentsDir = mkdtempSync(join(tmpdir(), 'dc-nl-handler-agents-'))
const bindingsDir = mkdtempSync(join(tmpdir(), 'dc-nl-handler-bindings-'))

beforeAll(() => {
  agents.setAgentsDir(agentsDir)
  bindings.setBindingsDir(bindingsDir)
})

beforeEach(() => {
  for (const dir of [agentsDir, bindingsDir]) {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) unlinkSync(join(dir, f))
    }
  }
})

afterAll(() => {
  rmSync(agentsDir, { recursive: true, force: true })
  rmSync(bindingsDir, { recursive: true, force: true })
})

interface Spy {
  sendCalls: Array<{ chatId: number; text: string }>
  evictCalls: number[]
  refreshCalls: Array<{ chatId: number; agentId: string }>
  logCalls: string[]
  deps: NlIntentDeps
}

function makeSpy(opts: { evictThrows?: boolean; sendThrows?: boolean } = {}): Spy {
  const sendCalls: Array<{ chatId: number; text: string }> = []
  const evictCalls: number[] = []
  const refreshCalls: Array<{ chatId: number; agentId: string }> = []
  const logCalls: string[] = []
  const deps: NlIntentDeps = {
    send: async (chatId, text) => {
      sendCalls.push({ chatId, text })
      if (opts.sendThrows) throw new Error('send boom')
    },
    evictChat: async (chatId) => {
      evictCalls.push(chatId)
      if (opts.evictThrows) throw new Error('evict boom')
    },
    refreshIcon: (chatId, agentId) => {
      refreshCalls.push({ chatId, agentId })
    },
    logf: (fmt, ...args) => {
      logCalls.push(`${fmt} ${args.map(String).join(' ')}`)
    },
  }
  return { sendCalls, evictCalls, refreshCalls, logCalls, deps }
}

function seedAgent(id: string, model = 'claude-sonnet-4-6'): void {
  agents.saveAgent({
    id,
    name: id,
    model,
    description: '',
    system: 'you are helpful',
    tools: [],
  })
}

function seedBinding(chatId: number, agentId: string | undefined): void {
  bindings.saveBinding({
    chatId,
    agentId,
    createdAt: new Date().toISOString(),
  })
}

describe('handleNlIntent — no-binding paths', () => {
  test('model-switch with no binding replies with not-bound message and persists nothing', async () => {
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'model-switch', tier: 'opus' }, 99)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.chatId).toBe(99)
    expect(spy.sendCalls[0]!.text).toMatch(/not bound to an agent/i)
    expect(spy.sendCalls[0]!.text).toMatch(/model-switch/i)
    expect(spy.evictCalls).toHaveLength(0)
    expect(spy.refreshCalls).toHaveLength(0)
  })

  test('trust-toggle with no binding replies with not-bound message', async () => {
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'trust-toggle', value: true }, 42)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.text).toMatch(/not bound to an agent/i)
    expect(spy.sendCalls[0]!.text).toMatch(/trust-toggle/i)
    expect(spy.evictCalls).toHaveLength(0)
  })

  test('refine with no binding replies with not-bound message', async () => {
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'refine' }, 7)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.text).toMatch(/not bound to an agent/i)
    expect(spy.sendCalls[0]!.text).toMatch(/refine/i)
  })

  test('binding without agentId is treated as no-binding', async () => {
    seedBinding(11, undefined)
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'model-switch', tier: 'haiku' }, 11)
    expect(spy.sendCalls[0]!.text).toMatch(/not bound to an agent/i)
  })
})

describe('handleNlIntent — model-switch success', () => {
  test('persists new model, evicts subagent, sends confirmation, refreshes icon', async () => {
    seedAgent('alice')
    seedBinding(50, 'alice')
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'model-switch', tier: 'opus' }, 50)
    const updated = agents.getAgent('alice')
    expect(updated?.model).toBe(agents.LATEST_MODELS.opus)
    expect(spy.evictCalls).toEqual([50])
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.text).toMatch(/switched to opus/i)
    expect(spy.sendCalls[0]!.text).toMatch(/next message/i)
    expect(spy.refreshCalls).toEqual([{ chatId: 50, agentId: 'alice' }])
  })

  test('evictChat rejection does not block the confirmation reply', async () => {
    seedAgent('alice')
    seedBinding(50, 'alice')
    const spy = makeSpy({ evictThrows: true })
    await handleNlIntent(spy.deps, { kind: 'model-switch', tier: 'haiku' }, 50)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.text).toMatch(/switched to haiku/i)
    expect(spy.logCalls.some((l) => /model-switch evict failed/.test(l))).toBe(true)
  })

  test('agents.setAgentModel throw surfaces a chat-side error message', async () => {
    seedBinding(50, 'ghost')
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'model-switch', tier: 'sonnet' }, 50)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.text).toMatch(/couldn't switch to sonnet/i)
  })
})

describe('handleNlIntent — trust-toggle success', () => {
  test('trust on persists, evicts, confirms', async () => {
    seedAgent('bob')
    seedBinding(60, 'bob')
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'trust-toggle', value: true }, 60)
    expect(agents.getSkipPermissions(agents.getAgent('bob')!)).toBe(true)
    expect(spy.evictCalls).toEqual([60])
    expect(spy.sendCalls[0]!.text).toMatch(/trust on/i)
    expect(spy.sendCalls[0]!.text).toMatch(/next message/i)
    expect(spy.refreshCalls).toEqual([{ chatId: 60, agentId: 'bob' }])
  })

  test('trust off persists and confirms', async () => {
    seedAgent('bob')
    agents.setAgentTrust('bob', true)
    seedBinding(60, 'bob')
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'trust-toggle', value: false }, 60)
    expect(agents.getSkipPermissions(agents.getAgent('bob')!)).toBe(false)
    expect(spy.sendCalls[0]!.text).toMatch(/trust off/i)
  })
})

describe('handleNlIntent — refine stub', () => {
  test('refine with bound agent replies with preview placeholder', async () => {
    seedAgent('carol')
    seedBinding(70, 'carol')
    const spy = makeSpy()
    await handleNlIntent(spy.deps, { kind: 'refine' }, 70)
    expect(spy.sendCalls).toHaveLength(1)
    // Message must be unambiguously transitional, not finished-feature copy.
    expect(spy.sendCalls[0]!.text).toMatch(/preview/i)
    // Must not call evict — refine is a no-op for now.
    expect(spy.evictCalls).toHaveLength(0)
  })
})
