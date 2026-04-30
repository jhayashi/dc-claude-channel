import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLeavesDir, getDefaultCatalog } from '../leaves.js'
import {
  composeIdentityPreamble,
  composeAgentName,
  createReuseChat,
} from '../apps/agent-setup-app.js'
import type { CoachAnswers } from '../coach.js'
import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import type { AppContext } from '../webxdc-app.js'

beforeEach(() => {
  setLeavesDir(join(import.meta.dir, '..', 'leaves'))
})

const empty: CoachAnswers = { parameters: {}, preferences: [], tools: [] }

describe('composeIdentityPreamble', () => {
  test('single leaf, no parameter', () => {
    const out = composeIdentityPreamble(['sleep-coach'], empty, getDefaultCatalog())
    expect(out.toLowerCase()).toContain('sleep coach')
    expect(out).toMatch(/^You are a /)
  })

  test('single leaf with parameter (Tutor / Algebra II)', () => {
    const answers: CoachAnswers = {
      parameters: { tutor: 'Algebra II' },
      preferences: [],
      tools: [],
    }
    const out = composeIdentityPreamble(['tutor'], answers, getDefaultCatalog())
    expect(out).toContain('Algebra II')
    expect(out.toLowerCase()).toContain('tutor')
  })

  test('mash-up with explicit lead', () => {
    const answers: CoachAnswers = {
      parameters: {},
      preferences: [],
      tools: [],
      leadLeafId: 'sleep-coach',
    }
    const out = composeIdentityPreamble(
      ['sleep-coach', 'stress-management-coach'],
      answers,
      getDefaultCatalog(),
    )
    expect(out).toContain('Sleep coach')
    expect(out).toContain('Stress-management coach')
    expect(out.toLowerCase()).toContain('lead lens')
  })

  test('mash-up without lead falls back to equal partners', () => {
    const out = composeIdentityPreamble(
      ['sleep-coach', 'stress-management-coach'],
      empty,
      getDefaultCatalog(),
    )
    expect(out.toLowerCase()).toContain('equal partners')
  })

  test('unknown leaf id silently dropped (no crash)', () => {
    // Defense-in-depth — composer is downstream of validation but should
    // not blow up on a bad id slipping through. Filter drops the unknown
    // id so the result is the same generic fallback as `[]`.
    const out = composeIdentityPreamble(['no-such-leaf-id'], empty, getDefaultCatalog())
    expect(out).toBe('You are a helpful assistant.')
  })

  test('empty leafIds yields a generic fallback', () => {
    const out = composeIdentityPreamble([], empty, getDefaultCatalog())
    expect(out.toLowerCase()).toContain('helpful assistant')
  })
})

describe('composeAgentName', () => {
  test('single leaf, no parameter', () => {
    const name = composeAgentName(['sleep-coach'], empty, getDefaultCatalog())
    expect(name).toBe('Sleep coach')
  })

  test('single leaf with parameter', () => {
    const answers: CoachAnswers = {
      parameters: { tutor: 'Algebra II' },
      preferences: [],
      tools: [],
    }
    const name = composeAgentName(['tutor'], answers, getDefaultCatalog())
    expect(name).toBe('Tutor (Algebra II)')
  })

  test('mash-up with explicit lead', () => {
    const answers: CoachAnswers = {
      parameters: {},
      preferences: [],
      tools: [],
      leadLeafId: 'sleep-coach',
    }
    const name = composeAgentName(
      ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      answers,
      getDefaultCatalog(),
    )
    expect(name).toBe('Sleep coach + 2 more')
  })

  test('mash-up without lead defaults to first leaf', () => {
    const name = composeAgentName(
      ['sleep-coach', 'stress-management-coach'],
      empty,
      getDefaultCatalog(),
    )
    expect(name).toBe('Sleep coach + 1 more')
  })

  test('empty leafIds returns generic name', () => {
    const name = composeAgentName([], empty, getDefaultCatalog())
    expect(name).toBe('New agent')
  })
})

// Phase 12 — reuse chat handler. Stubs the DC client with the surface
// createReuseChat actually touches (createGroup, addContactToChat,
// setChatProfileImage, send). Verifies the chat is created with the
// agent's name, the binding is persisted, and decorate runs through
// (badge attempt + intro send).
describe('createReuseChat', () => {
  const agentsDir = mkdtempSync(join(tmpdir(), 'dc-reuse-agents-'))
  const bindingsDir = mkdtempSync(join(tmpdir(), 'dc-reuse-bindings-'))
  const accessDir = mkdtempSync(join(tmpdir(), 'dc-reuse-access-'))

  beforeEach(() => {
    agents.setAgentsDir(agentsDir)
    bindings.setBindingsDir(bindingsDir)
    access.setApprovedDir(accessDir)
    for (const dir of [agentsDir, bindingsDir, accessDir]) {
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          try { unlinkSync(join(dir, f)) } catch { /* ignore directories */ }
        }
      }
    }
  })

  function makeStubCtx(newChatId: number): {
    ctx: AppContext
    createGroup: ReturnType<typeof mock>
    addContactToChat: ReturnType<typeof mock>
    setChatProfileImage: ReturnType<typeof mock>
    send: ReturnType<typeof mock>
  } {
    const createGroup = mock(async (_name: string) => newChatId)
    const addContactToChat = mock(async () => {})
    const setChatProfileImage = mock(async () => {})
    const send = mock(async () => 1)
    const client = {
      createGroup,
      addContactToChat,
      setChatProfileImage,
      send,
    } as unknown as AppContext['client']
    const ctx: AppContext = {
      client,
      mcp: {} as unknown as AppContext['mcp'],
      isAllowed: (chatId: number) => access.isAllowed(chatId),
      allowedChats: () => access.allowedChats(),
      logf: () => {},
      safeName: (s: string) => s,
      registerWebXDCMsg: () => {},
      unregisterWebXDCMsg: () => {},
      evictSubagent: async () => {},
      getAvailableMcpServers: () => [],
      getConnectedMcpServers: () => [],
      scheduleStore: {} as unknown as AppContext['scheduleStore'],
      subagentCache: { evictChat: async () => {} },
      cleanupChatState: async () => {},
    }
    return { ctx, createGroup, addContactToChat, setChatProfileImage, send }
  }

  function seedAgent(): agents.AgentDef {
    const def: agents.AgentDef = {
      id: 'reuse-test-agent',
      name: 'Reuse Test Agent',
      model: 'claude-sonnet-4-6',
      description: '',
      system: 'you are helpful',
      tools: [],
    }
    agents.saveAgent(def)
    return def
  }

  test('creates DC chat with the agent name and adds the owner contact', async () => {
    const agent = seedAgent()
    const { ctx, createGroup, addContactToChat } = makeStubCtx(500)
    await createReuseChat(ctx, agent, 11)
    expect(createGroup).toHaveBeenCalledTimes(1)
    expect(createGroup.mock.calls[0]).toEqual(['Reuse Test Agent'])
    expect(addContactToChat).toHaveBeenCalledTimes(1)
    expect(addContactToChat.mock.calls[0]).toEqual([500, 11])
  })

  test('persists the binding linking the new chat to the agent', async () => {
    const agent = seedAgent()
    const { ctx } = makeStubCtx(500)
    const returnedChatId = await createReuseChat(ctx, agent, 11)
    expect(returnedChatId).toBe(500)
    const binding = bindings.getBinding(500)
    expect(binding).not.toBeNull()
    expect(binding!.agentId).toBe(agent.id)
  })

  test('approves the new chat for the owner', async () => {
    const agent = seedAgent()
    const { ctx } = makeStubCtx(500)
    await createReuseChat(ctx, agent, 11)
    expect(access.isAllowed(500)).toBe(true)
    expect(access.getOwner(500)).toBe(11)
  })

  test('sends the intro greeting in the new chat', async () => {
    const agent = seedAgent()
    const { ctx, send } = makeStubCtx(500)
    await createReuseChat(ctx, agent, 11)
    // decorateAgentChat -> ctx.client.send with the intro line.
    expect(send).toHaveBeenCalled()
    const greeting = send.mock.calls.find((c) => c[0] === 500)
    expect(greeting).toBeDefined()
    expect(String(greeting![1])).toMatch(/Reuse Test Agent/)
  })

  test('default-agent path: ensureDefaultAgent + createReuseChat lazy-creates and binds', async () => {
    // No seedAgent here — ensureDefaultAgent should auto-create the
    // built-in default. Mirrors what the start-default-chat handler
    // does end-to-end.
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).toBeNull()
    const defaultAgent = agents.ensureDefaultAgent()
    expect(defaultAgent.id).toBe(agents.DEFAULT_AGENT_ID)
    const { ctx } = makeStubCtx(600)
    const newChatId = await createReuseChat(ctx, defaultAgent, 11)
    expect(newChatId).toBe(600)
    const binding = bindings.getBinding(600)
    expect(binding).not.toBeNull()
    expect(binding!.agentId).toBe(agents.DEFAULT_AGENT_ID)
  })

  test('default-agent path: re-creates the default if the user deleted it', async () => {
    // Create + delete to simulate "user removed Default agent in Manage".
    agents.ensureDefaultAgent()
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).not.toBeNull()
    // Note: deleteAgent throws on undeletable; this is just a paranoia
    // path. In practice ensureDefaultAgent re-seeds from a missing-file
    // state.
    // Force-remove the on-disk file manually.
    rmSync(join(agentsDir, `${agents.DEFAULT_AGENT_ID}.yaml`), { force: true })
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).toBeNull()
    const reseeded = agents.ensureDefaultAgent()
    expect(reseeded.id).toBe(agents.DEFAULT_AGENT_ID)
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).not.toBeNull()
  })
})
