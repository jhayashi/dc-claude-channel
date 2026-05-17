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
      // v1.3 slice 7: agents are subdirectories, not flat files.
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true })
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
  refineCalls: Array<{ chatId: number; agentId: string }>
  logCalls: string[]
  deps: NlIntentDeps
}

function makeSpy(opts: {
  evictThrows?: boolean
  sendThrows?: boolean
  refineThrows?: boolean
  refineReturnsNull?: boolean
  refineQuestion?: string
} = {}): Spy {
  const sendCalls: Array<{ chatId: number; text: string }> = []
  const evictCalls: number[] = []
  const refreshCalls: Array<{ chatId: number; agentId: string }> = []
  const refineCalls: Array<{ chatId: number; agentId: string }> = []
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
    startRefineSession: async (chatId, agentId) => {
      refineCalls.push({ chatId, agentId })
      if (opts.refineThrows) throw new Error('refine boom')
      if (opts.refineReturnsNull) return null
      return opts.refineQuestion ?? 'What would you like to change about how I work?'
    },
  }
  return { sendCalls, evictCalls, refreshCalls, refineCalls, logCalls, deps }
}

function seedAgent(name: string, model = 'claude-sonnet-4-6'): void {
  agents.saveAgent({
    name,
    description: '',
    model,
    tools: 'mcp__dc',
    body: 'you are helpful\n',
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

describe('handleNlIntent — refine flow', () => {
  test('refine with bound agent starts a refine session and sends the first question', async () => {
    seedAgent('carol')
    seedBinding(70, 'carol')
    const spy = makeSpy({ refineQuestion: 'What would you like to change about how I work?' })
    await handleNlIntent(spy.deps, { kind: 'refine' }, 70)
    expect(spy.refineCalls).toEqual([{ chatId: 70, agentId: 'carol' }])
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.text.toLowerCase()).toMatch(/change|how i work/)
    // Refine must NOT evict — the existing subagent stays bound to the
    // same session; the prompt rewrite happens at coach-done.
    expect(spy.evictCalls).toHaveLength(0)
  })

  test('refine while another session is in flight tells the user to finish first', async () => {
    seedAgent('carol')
    seedBinding(70, 'carol')
    const spy = makeSpy({ refineReturnsNull: true })
    await handleNlIntent(spy.deps, { kind: 'refine' }, 70)
    expect(spy.refineCalls).toHaveLength(1)
    expect(spy.sendCalls).toHaveLength(1)
    expect(spy.sendCalls[0]!.text.toLowerCase()).toMatch(/middle of something|finish/)
  })

  test('refine with a thrown startRefineSession surfaces the error to chat', async () => {
    seedAgent('carol')
    seedBinding(70, 'carol')
    const spy = makeSpy({ refineThrows: true })
    await handleNlIntent(spy.deps, { kind: 'refine' }, 70)
    expect(spy.sendCalls[0]!.text.toLowerCase()).toMatch(/couldn't start refine/)
    expect(spy.logCalls.some((l) => /refine start failed/.test(l))).toBe(true)
  })
})
