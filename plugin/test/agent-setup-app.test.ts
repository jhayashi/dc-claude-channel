import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLeavesDir, getDefaultCatalog } from '../leaves.js'
import {
  composeIdentityPreamble,
  composeAgentName,
  createReuseChat,
  rebindChat,
  resolveAttachAgent,
  handleListContacts,
  handleAssignRole,
  buildCreateAgentToolsCsv,
  shouldResendCard,
  parseSessions,
  resolveMemoryBoost,
  type Session,
} from '../apps/agent-setup-app.js'
import type { CoachAnswers } from '../coach.js'
import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import * as sessionAgents from '../session-agents.js'
import type { AppContext } from '../webxdc-app.js'
import { setEventDir } from '../events.js'

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
          // v1.3 slice 7: agents/<id>/ are directories. rmSync handles both.
          try { rmSync(join(dir, f), { recursive: true, force: true }) } catch { /* ignore */ }
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
      name: 'reuse-test-agent',
      'x-dc-display-name': 'Reuse Test Agent',
      model: 'claude-sonnet-4-6',
      description: '',
      body: 'you are helpful',
      tools: 'mcp__dc',
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
    expect(binding!.agentId).toBe(agent.name)
  })

  test('approves the new chat for the owner', async () => {
    const agent = seedAgent()
    const { ctx } = makeStubCtx(500)
    await createReuseChat(ctx, agent, 11)
    expect(access.isAllowed(500)).toBe(true)
    expect(access.firstPermissionedContact(500)).toBe(11)
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
    expect(defaultAgent.name).toBe(agents.DEFAULT_AGENT_ID)
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
    // Force-remove the agent's .md file manually (v1.4 layout).
    rmSync(join(agentsDir, `${agents.DEFAULT_AGENT_ID}.md`), { force: true })
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).toBeNull()
    const reseeded = agents.ensureDefaultAgent()
    expect(reseeded.name).toBe(agents.DEFAULT_AGENT_ID)
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).not.toBeNull()
  })
})

describe('rebindChat', () => {
  const agentsDir = mkdtempSync(join(tmpdir(), 'dc-rebind-agents-'))
  const bindingsDir = mkdtempSync(join(tmpdir(), 'dc-rebind-bindings-'))
  const accessDir = mkdtempSync(join(tmpdir(), 'dc-rebind-access-'))

  beforeEach(() => {
    agents.setAgentsDir(agentsDir)
    bindings.setBindingsDir(bindingsDir)
    access.setApprovedDir(accessDir)
    for (const dir of [agentsDir, bindingsDir, accessDir]) {
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          try { rmSync(join(dir, f), { recursive: true, force: true }) } catch { /* ignore */ }
        }
      }
    }
  })

  function makeStubCtx(): { ctx: AppContext; send: ReturnType<typeof mock>; evict: ReturnType<typeof mock> } {
    const send = mock(async () => 1)
    const setChatProfileImage = mock(async () => {})
    const evict = mock(async () => {})
    const client = { send, setChatProfileImage } as unknown as AppContext['client']
    const ctx: AppContext = {
      client,
      mcp: {} as unknown as AppContext['mcp'],
      isAllowed: (chatId: number) => access.isAllowed(chatId),
      allowedChats: () => access.allowedChats(),
      logf: () => {},
      safeName: (s: string) => s,
      registerWebXDCMsg: () => {},
      unregisterWebXDCMsg: () => {},
      evictSubagent: evict,
      getAvailableMcpServers: () => [],
      getConnectedMcpServers: () => [],
      scheduleStore: {} as unknown as AppContext['scheduleStore'],
      subagentCache: { evictChat: async () => {} },
      cleanupChatState: async () => {},
    }
    return { ctx, send, evict }
  }

  function seedAgent(name: string, model = 'claude-sonnet-4-6'): agents.AgentDef {
    const def: agents.AgentDef = {
      name, 'x-dc-display-name': name, model, description: '', body: 'x', tools: 'mcp__dc',
    }
    agents.saveAgent(def)
    return def
  }

  test('swaps agentId, starts a fresh session, preserves workingDir + createdAt', async () => {
    const oldAgent = seedAgent('old-agent')
    const newAgent = seedAgent('new-agent')
    bindings.bindAgent(700, oldAgent.name, { inheritClaudeMd: false })
    const seeded = bindings.getBinding(700)!
    bindings.saveBinding({ ...seeded, sessionId: 'sess-OLD', workingDir: '/repo/x' })

    const { ctx, evict } = makeStubCtx()
    await rebindChat(ctx, 700, newAgent)

    const after = bindings.getBinding(700)!
    expect(after.agentId).toBe('new-agent')
    expect(after.sessionId).toBeUndefined()        // fresh session
    expect(after.workingDir).toBe('/repo/x')        // project context preserved
    expect(after.createdAt).toBe(seeded.createdAt)  // not a new binding
    expect(evict).toHaveBeenCalledWith(700)         // in-flight subagent dropped
  })

  test('decorates the chat (avatar swap + intro line) on the SAME chat id', async () => {
    seedAgent('old-agent')
    const newAgent = seedAgent('new-agent')
    bindings.bindAgent(701, 'old-agent', { inheritClaudeMd: false })
    const { ctx, send } = makeStubCtx()
    await rebindChat(ctx, 701, newAgent)
    expect(send.mock.calls.some((c) => c[0] === 701)).toBe(true)
  })

  test('throws when the chat is already on that agent (no-op rebind)', async () => {
    const agent = seedAgent('same-agent')
    bindings.bindAgent(702, 'same-agent', { inheritClaudeMd: false })
    const { ctx } = makeStubCtx()
    await expect(rebindChat(ctx, 702, agent)).rejects.toThrow(/already on/i)
  })
})

describe('resolveAttachAgent', () => {
  const agentsDir2 = mkdtempSync(join(tmpdir(), 'dc-resolve-agents-'))
  const bindingsDir2 = mkdtempSync(join(tmpdir(), 'dc-resolve-bindings-'))
  const sessionAgentsDir = mkdtempSync(join(tmpdir(), 'dc-resolve-session-agents-'))

  beforeEach(() => {
    agents.setAgentsDir(agentsDir2)
    bindings.setBindingsDir(bindingsDir2)
    sessionAgents.setIndexDir(sessionAgentsDir)
    for (const dir of [agentsDir2, bindingsDir2, sessionAgentsDir]) {
      for (const f of readdirSync(dir)) {
        rmSync(join(dir, f), { recursive: true, force: true })
      }
    }
  })

  test('prefers session-agents index when entry exists', () => {
    // Source chat has a different agent than the index
    bindings.saveBinding({ chatId: 10, agentId: 'source-agent', createdAt: new Date().toISOString() })
    sessionAgents.setAgentForSession('sess-abc', 'original-agent')

    expect(resolveAttachAgent('sess-abc', 10)).toBe('original-agent')
  })

  test('falls back to source binding agentId when no index entry', () => {
    bindings.saveBinding({ chatId: 10, agentId: 'source-agent', createdAt: new Date().toISOString() })

    expect(resolveAttachAgent('sess-xyz', 10)).toBe('source-agent')
  })

  test('falls back to claude-code when neither index nor source binding has an agentId', () => {
    bindings.saveBinding({ chatId: 10, createdAt: new Date().toISOString() })

    expect(resolveAttachAgent('sess-xyz', 10)).toBe(agents.DEFAULT_AGENT_ID)
  })

  test('falls back to claude-code when source chat has no binding at all', () => {
    expect(resolveAttachAgent('sess-xyz', 999)).toBe(agents.DEFAULT_AGENT_ID)
  })
})

describe('contact management handlers', () => {
  let tmpAccess: string
  let tmpAgents: string
  let tmpEvents: string
  let tmpBindings: string

  beforeEach(() => {
    tmpAccess = mkdtempSync(join(tmpdir(), 'dc-cm-access-'))
    tmpAgents = mkdtempSync(join(tmpdir(), 'dc-cm-agents-'))
    tmpEvents = mkdtempSync(join(tmpdir(), 'dc-cm-events-'))
    tmpBindings = mkdtempSync(join(tmpdir(), 'dc-cm-bindings-'))
    access.setApprovedDir(tmpAccess)
    access.setContactsAgentsDir(tmpAgents)
    setEventDir(tmpEvents)
    bindings.setBindingsDir(tmpBindings)
  })

  afterEach(() => {
    try { rmSync(tmpAccess, { recursive: true, force: true }) } catch {}
    try { rmSync(tmpAgents, { recursive: true, force: true }) } catch {}
    try { rmSync(tmpEvents, { recursive: true, force: true }) } catch {}
    try { rmSync(tmpBindings, { recursive: true, force: true }) } catch {}
  })

  /**
   * v1.4.9 Phase 4: handleListContacts now narrows the picker universe
   * to chats bound to the managed agent (not all bot chats). Tests that
   * use sourceChatId=0 (unbound → managedAgentId=claude-code) need to
   * bind the fixture chats to claude-code so the picker sees their
   * members. This helper does that. Pass it the chat IDs that should
   * be in the picker universe.
   */
  function bindToDefault(chatIds: number[]): void {
    for (const chatId of chatIds) {
      bindings.saveBinding({
        chatId,
        agentId: agents.DEFAULT_AGENT_ID,
        createdAt: new Date().toISOString(),
      })
    }
  }

  function makeCtx(
    lookupResult: number | null = null,
    chatMembership: Map<number, number[]> = new Map(),
    contactOverrides: Map<number, { isBot?: boolean; address?: string }> = new Map(),
    selfAddr: string | null = null,
  ): {
    ctx: AppContext
    sendWebXDCUpdate: ReturnType<typeof mock>
    lookupContactByAddr: ReturnType<typeof mock>
  } {
    const sendWebXDCUpdate = mock(async () => {})
    const lookupContactByAddr = mock(async (_addr: string) => lookupResult)
    const getContact = mock(async (id: number) => ({
      displayName: `Contact-${id}`,
      name: `Contact-${id}`,
      address: contactOverrides.get(id)?.address ?? `c${id}@example.com`,
      isVerified: false,
      isBot: contactOverrides.get(id)?.isBot ?? false,
    }))
    const getChats = mock(async () => Array.from(chatMembership.keys()))
    const getChatContacts = mock(async (chatId: number) => chatMembership.get(chatId) ?? [])
    const getSelfAddress = mock(async () => selfAddr)
    const client = { sendWebXDCUpdate, lookupContactByAddr, getContact, getChats, getChatContacts, getSelfAddress } as unknown as AppContext['client']
    const ctx: AppContext = {
      client,
      mcp: {} as unknown as AppContext['mcp'],
      isAllowed: () => false,
      allowedChats: () => [],
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
    return { ctx, sendWebXDCUpdate, lookupContactByAddr }
  }

  function capturedUpdate(sendWebXDCUpdate: ReturnType<typeof mock>): unknown {
    const raw = JSON.parse(sendWebXDCUpdate.mock.calls[0][1] as string) as { payload: unknown }
    return raw.payload
  }

  function readPermissionsLog(): unknown {
    const files = readdirSync(tmpEvents).filter(f => f.startsWith('permissions-'))
    if (files.length === 0) return null
    return JSON.parse(readFileSync(join(tmpEvents, files[0]), 'utf8').trim())
  }

  // ── handleListContacts ───────────────────────────────────────────────────

  test('handleListContacts returns active members across all bot chats (paired + unpaired)', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 50, 'Alice')
    bindToDefault([10, 11]) // Phase 4: picker universe = chats bound to managed agent
    const { ctx, sendWebXDCUpdate } = makeCtx(null, new Map([
      [10, [1, 50, 70]], // chat 10: self + paired Alice + unpaired 70
      [11, [1, 50, 80]], // chat 11: self + Alice + unpaired 80
    ]))

    await handleListContacts(ctx, 99, 0)

    const update = capturedUpdate(sendWebXDCUpdate) as { type: string; contacts: { contactId: number; role: string | null }[] }
    expect(update.type).toBe('contacts_loaded')
    const byId = new Map(update.contacts.map(c => [c.contactId, c]))
    expect(Array.from(byId.keys()).sort((a, b) => a - b)).toEqual([50, 70, 80])
    expect(byId.get(50)!.role).toBe('subscriber') // paired
    expect(byId.get(70)!.role).toBe(null) // needs role
    expect(byId.get(80)!.role).toBe(null) // needs role
  })

  test('handleListContacts skips DC reserved system contacts (id ≤ 9)', async () => {
    bindToDefault([10])
    const { ctx, sendWebXDCUpdate } = makeCtx(null, new Map([
      [10, [1, 2, 5, 9, 50]], // self + info + device + reserved + a real contact
    ]))

    await handleListContacts(ctx, 99, 0)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: { contactId: number }[] }
    expect(update.contacts.map(c => c.contactId)).toEqual([50])
  })

  test('handleListContacts INCLUDES bots so they can be permissioned', async () => {
    bindToDefault([10])
    const { ctx, sendWebXDCUpdate } = makeCtx(
      null,
      new Map([[10, [1, 50, 99]]]),
      new Map([[99, { isBot: true }]]),
    )

    await handleListContacts(ctx, 99, 0)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: { contactId: number; isBot: boolean }[] }
    const ids = update.contacts.map(c => c.contactId).sort((a, b) => a - b)
    expect(ids).toEqual([50, 99])
    // isBot is surfaced so the UI can show a "bot" badge, but doesn't gate inclusion
    expect(update.contacts.find(c => c.contactId === 99)!.isBot).toBe(true)
  })

  test('handleListContacts excludes self-as-contact entries by address match', async () => {
    bindToDefault([10])
    const { ctx, sendWebXDCUpdate } = makeCtx(
      null,
      new Map([[10, [1, 50, 88]]]),
      new Map([[88, { address: 'bot@example.com' }]]),
      'bot@example.com',
    )

    await handleListContacts(ctx, 99, 0)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: { contactId: number }[] }
    expect(update.contacts.map(c => c.contactId)).toEqual([50])
  })

  test('handleListContacts with no chats sends empty array', async () => {
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleListContacts(ctx, 99, 0)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: unknown[] }
    expect(update.contacts).toEqual([])
  })

  // ── Phase 4 (D3 — Knob 1 b): picker universe narrowing ─────────────────────
  //
  // Pre-v1.4.9, handleListContacts' universe was every chat the bot is in
  // (`client.getChats()`). Phase 4 narrows it to chats *bound to the managed
  // agent* so a contact you only know via librarian doesn't pollute
  // dc-developer's role picker. These tests pin the narrowing.

  test('Phase 4: handleListContacts narrows universe to chats bound to managed agent', async () => {
    // Two chats with different bindings — only one should appear in the picker.
    bindings.saveBinding({
      chatId: 14, agentId: 'dc-developer', createdAt: new Date().toISOString(),
    })
    bindings.saveBinding({
      chatId: 32, agentId: 'olliespa', createdAt: new Date().toISOString(),
    })
    const { ctx, sendWebXDCUpdate } = makeCtx(null, new Map([
      [14, [1, 50]],   // dc-developer chat: Alice
      [32, [1, 60]],   // olliespa chat: Bob
    ]))

    // Open settings from chat 14 → managed agent = dc-developer →
    // picker should show chat 14's members only (Alice, not Bob).
    await handleListContacts(ctx, 99, 14)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: { contactId: number }[] }
    const ids = update.contacts.map(c => c.contactId).sort((a, b) => a - b)
    expect(ids).toEqual([50])
    expect(ids).not.toContain(60)
  })

  test('Phase 4: same chats, different sourceChatId → different picker universes', async () => {
    bindings.saveBinding({
      chatId: 14, agentId: 'dc-developer', createdAt: new Date().toISOString(),
    })
    bindings.saveBinding({
      chatId: 32, agentId: 'olliespa', createdAt: new Date().toISOString(),
    })
    const { ctx: ctxA, sendWebXDCUpdate: sendA } = makeCtx(null, new Map([
      [14, [1, 50]],
      [32, [1, 60]],
    ]))
    const { ctx: ctxB, sendWebXDCUpdate: sendB } = makeCtx(null, new Map([
      [14, [1, 50]],
      [32, [1, 60]],
    ]))

    await handleListContacts(ctxA, 99, 14) // dc-developer view
    await handleListContacts(ctxB, 99, 32) // olliespa view

    const idsA = (JSON.parse(sendA.mock.calls[0][1] as string) as { payload: { contacts: { contactId: number }[] } })
      .payload.contacts.map(c => c.contactId)
    const idsB = (JSON.parse(sendB.mock.calls[0][1] as string) as { payload: { contacts: { contactId: number }[] } })
      .payload.contacts.map(c => c.contactId)
    expect(idsA).toEqual([50])
    expect(idsB).toEqual([60])
  })

  test('Phase 4: empty picker when managed agent has no bindings', async () => {
    bindings.saveBinding({
      chatId: 32, agentId: 'olliespa', createdAt: new Date().toISOString(),
    })
    const { ctx, sendWebXDCUpdate } = makeCtx(null, new Map([
      [32, [1, 60]],
    ]))

    // Source chat 14 has no binding → falls back to claude-code.
    // claude-code has no bindings either → empty picker.
    await handleListContacts(ctx, 99, 14)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: unknown[] }
    expect(update.contacts).toEqual([])
  })

  test('Phase 4: multiple chats bound to same agent are all in the picker (dedup)', async () => {
    bindings.saveBinding({
      chatId: 14, agentId: 'dc-developer', createdAt: new Date().toISOString(),
    })
    bindings.saveBinding({
      chatId: 15, agentId: 'dc-developer', createdAt: new Date().toISOString(),
    })
    const { ctx, sendWebXDCUpdate } = makeCtx(null, new Map([
      [14, [1, 50]],
      [15, [1, 50, 51]], // 50 dedupes; 51 is new
    ]))

    await handleListContacts(ctx, 99, 14)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: { contactId: number }[] }
    const ids = update.contacts.map(c => c.contactId).sort((a, b) => a - b)
    expect(ids).toEqual([50, 51])
  })

  // Regression guard for the silent-strip bug found 2026-05-30 in chat 27:
  // commit 9035b34 (2026-05-03 "retire legacy new-chat and Paired devices
  // views") accidentally removed the `payload.type === 'list_contacts'`
  // dispatcher branch alongside the legacy view cleanup. handleListContacts
  // (above) stayed exported and unit-tested, but no wire reached it from
  // onWebXDCUpdate — the Contacts overflow menu on any agent silently
  // produced an empty UI ("None" in needs / assigned / subscribers).
  //
  // This is a structural test (matches source text), not a behavioral one,
  // because seeding the private `sessions` map for an end-to-end dispatcher
  // call would require a test-only seam that doesn't exist yet. Keep this
  // test even if a richer integration harness lands — the failure mode it
  // catches (someone strips the routing during cleanup) is exactly what
  // happened once and could happen again.
  test('list_contacts payload is dispatched to handleListContacts (regression for 9035b34)', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', 'apps', 'agent-setup-app.ts'),
      'utf-8',
    )
    expect(src).toMatch(/payload\.type === 'list_contacts'/)
    expect(src).toMatch(/handleListContacts\(ctx,\s*session\.msgId,\s*session\.sourceChatId\)/)
  })

  // Same regression as the list_contacts test above — commit 9035b34 also
  // stripped the assign_role dispatcher branch. handleAssignRole has 7 unit
  // tests (below) that all pass, but the wire from onWebXDCUpdate was
  // missing. Restoring only list_contacts and not assign_role would create a
  // half-broken UI: Joe could see contacts but role-save taps in the picker
  // would silently no-op. Both wires are restored together.
  test('assign_role payload is dispatched to handleAssignRole (regression for 9035b34)', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', 'apps', 'agent-setup-app.ts'),
      'utf-8',
    )
    expect(src).toMatch(/payload\.type === 'assign_role'/)
    expect(src).toMatch(/handleAssignRole\(ctx,\s*session\.msgId/)
  })

  // ── buildCreateAgentToolsCsv ─────────────────────────────────────────────
  //
  // The form's collectCreateToolPickerState returns `null` for a category
  // when ALL boxes are checked (user accepted the picker's defaults). The
  // server's tools-CSV builder must expand that null back to the full set
  // the picker showed. The bug Joe hit on 2026-05-30: the legacy `?? []`
  // collapse treated null as empty, so new agents created via the + Create
  // new agent form (test agent) had only mcp__dc__* tools and no built-ins
  // like Bash/Read/Edit. These tests pin the protocol.

  test('buildCreateAgentToolsCsv: null builtins → all ALL_BUILTIN_TOOLS (user accepted picker defaults)', () => {
    const csv = buildCreateAgentToolsCsv(null, null)
    // Sample a few core ones — exhaustive list is in ALL_BUILTIN_TOOLS
    expect(csv).toContain('Bash')
    expect(csv).toContain('Read')
    expect(csv).toContain('Edit')
    expect(csv).toContain('Write')
    expect(csv).toContain('Grep')
    expect(csv).toContain('Glob')
    expect(csv).toContain('WebFetch')
  })

  test('buildCreateAgentToolsCsv: undefined builtins → all ALL_BUILTIN_TOOLS (payload omitted the field)', () => {
    const csv = buildCreateAgentToolsCsv(undefined, undefined)
    expect(csv).toContain('Bash')
    expect(csv).toContain('Read')
  })

  test('buildCreateAgentToolsCsv: explicit empty array → literally no builtins (user unchecked all boxes)', () => {
    const csv = buildCreateAgentToolsCsv([], null)
    expect(csv).not.toContain('Bash')
    expect(csv).not.toContain('Read')
    // mcp__dc gets injected by saveAgent, not by this function, so the csv
    // for empty-builtins / null-mcp is just an empty string.
    expect(csv).toBe('')
  })

  test('buildCreateAgentToolsCsv: explicit subset → just those builtins', () => {
    const csv = buildCreateAgentToolsCsv(['Bash', 'Read'], null)
    expect(csv).toBe('Bash, Read')
  })

  test('buildCreateAgentToolsCsv: MCP servers prefix with mcp__ and join with builtins', () => {
    const csv = buildCreateAgentToolsCsv(['Bash'], ['slack', 'gmail'])
    expect(csv).toBe('Bash, mcp__slack, mcp__gmail')
  })

  test('buildCreateAgentToolsCsv: null MCP servers → no MCP servers in CSV (conservative — only saveAgent injects mcp__dc)', () => {
    // Intentionally conservative: auto-adding all available MCP servers
    // (Slack, Gmail, etc.) to every new agent is invasive. User must
    // explicitly check MCP server boxes to attach them. mcp__dc is added
    // unconditionally downstream by saveAgent's ensureMcpDc, so it doesn't
    // appear here.
    const csv = buildCreateAgentToolsCsv(['Bash'], null)
    expect(csv).toBe('Bash')
  })


  // ── handleAssignRole ─────────────────────────────────────────────────────

  // Shared always-authorize stub for handleAssignRole unit tests.
  // The §6 gate is exercised separately in contacts-auth.test.ts.
  const alwaysOk = async () => ({ ok: true as const })

  test('handleAssignRole updates contact role on disk', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx } = makeCtx()

    await handleAssignRole(ctx, 99, 0, 5, 'family-member', null, alwaysOk)

    expect(access.loadContact(access.DEFAULT_AGENT_ID, 5)?.role).toBe('family-member')
  })

  test('handleAssignRole sends role_assigned with updated contact', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleAssignRole(ctx, 99, 0, 5, 'trusted-agent', null, alwaysOk)

    expect(sendWebXDCUpdate).toHaveBeenCalledTimes(1)
    const update = capturedUpdate(sendWebXDCUpdate) as { type: string; contact: { contactId: number; role: string } }
    expect(update.type).toBe('role_assigned')
    expect(update.contact.contactId).toBe(5)
    expect(update.contact.role).toBe('trusted-agent')
  })

  test('handleAssignRole resolves assignerContactId via lookupContactByAddr', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx, lookupContactByAddr } = makeCtx(42)

    await handleAssignRole(ctx, 99, 0, 5, 'family-member', 'alice@nine.testrun.org', alwaysOk)

    expect(lookupContactByAddr).toHaveBeenCalledWith('alice@nine.testrun.org')
    const entry = readPermissionsLog() as { assignerContactId: number; reason: string }
    expect(entry.assignerContactId).toBe(42)
    expect(entry.reason).toBe('picked')
  })

  test('handleAssignRole logs null assignerContactId when address not in DC contacts', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx } = makeCtx(null)

    await handleAssignRole(ctx, 99, 0, 5, 'family-member', 'unknown@example.com', alwaysOk)

    const entry = readPermissionsLog() as { assignerContactId: null }
    expect(entry.assignerContactId).toBeNull()
  })

  test('handleAssignRole logs RoleAssignmentEvent with previousRole', async () => {
    access.setContactRole(access.DEFAULT_AGENT_ID, 5, 'subscriber', 'Alice')
    const { ctx } = makeCtx()

    await handleAssignRole(ctx, 99, 0, 5, 'family-member', null, alwaysOk)

    const entry = readPermissionsLog() as { assignedRole: string; previousRole: string }
    expect(entry.assignedRole).toBe('family-member')
    expect(entry.previousRole).toBe('subscriber')
  })

  test('handleAssignRole with unpaired contact creates record (Option B)', async () => {
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleAssignRole(ctx, 99, 0, 999, 'family-member', null, alwaysOk)

    // Record now exists for the previously-unpaired contact
    expect(access.loadContact(access.DEFAULT_AGENT_ID, 999)?.role).toBe('family-member')
    // role_assigned reply was sent so the picker spinner can dismiss
    expect(sendWebXDCUpdate).toHaveBeenCalledTimes(1)
    // Audit entry recorded with previousRole=null (no prior record)
    const entry = readPermissionsLog() as { assignedRole: string; previousRole: string | null }
    expect(entry.assignedRole).toBe('family-member')
    expect(entry.previousRole).toBeNull()
  })

  test('handleAssignRole with null role is a no-op', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleAssignRole(ctx, 99, 0, 5, null as unknown as string, null, alwaysOk)

    expect(sendWebXDCUpdate).not.toHaveBeenCalled()
  })
})

// ─── version-aware session reuse (chat 14 msg 8950, 2026-05-31) ────────────
//
// Joe reported (chat 14 msg 8916/8938) that an old agent-setup card cached
// client-side from a prior send would render, broadcast a version_mismatch,
// and surface an "outdated, upgrading…" message before the new card replaced
// it. Tracing showed sendInit reuses the existing session map entry (just
// pushes an update to the old msgId) when one exists — regardless of whether
// the on-disk HTML version has moved past the version that card was sent at.
//
// Fix: track appVersion per Session. On sendInit, only reuse the existing
// session when its recorded version matches the current on-disk HTML version.
// Otherwise treat it as stale and send a fresh card (skipping the
// version_mismatch round-trip the old card would have triggered).
describe('shouldResendCard (version-aware session reuse)', () => {
  test('no existing session → send new card', () => {
    expect(shouldResendCard(undefined, 2.15)).toBe(true)
  })

  test('existing session with matching version → reuse (push update)', () => {
    const existing: Session = { msgId: 10, sourceChatId: 14, appVersion: 2.15 }
    expect(shouldResendCard(existing, 2.15)).toBe(false)
  })

  test('existing session with stale version → send new card', () => {
    const existing: Session = { msgId: 10, sourceChatId: 14, appVersion: 2.14 }
    expect(shouldResendCard(existing, 2.15)).toBe(true)
  })

  test('legacy session without appVersion field → send new card (treat as stale)', () => {
    // Backwards compat: any session persisted before this change has no
    // appVersion. Force a fresh card so the user lands on the current HTML
    // immediately instead of going through the version_mismatch flow.
    const legacy: Session = { msgId: 10, sourceChatId: 14 }
    expect(shouldResendCard(legacy, 2.15)).toBe(true)
  })

  test('appVersion stored as the *float* the HTML reports (no string coercion)', () => {
    // APP_VERSION is parsed as a float by xdc-builder. The session must
    // store the same shape so === comparison works without surprises.
    const existing: Session = { msgId: 10, sourceChatId: 14, appVersion: 2.14 }
    expect(shouldResendCard(existing, '2.14' as unknown as number)).toBe(true) // type mismatch → resend
    expect(shouldResendCard(existing, 2.14)).toBe(false) // exact match → reuse
  })
})

describe('parseSessions (backwards-compat with legacy sessions file)', () => {
  test('round-trips appVersion when present', () => {
    const raw = JSON.stringify([
      { msgId: 100, sourceChatId: 14, appVersion: 2.15 },
    ])
    const out = parseSessions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].appVersion).toBe(2.15)
    expect(out[0].msgId).toBe(100)
    expect(out[0].sourceChatId).toBe(14)
  })

  test('loads legacy entries without appVersion as undefined (no error)', () => {
    const raw = JSON.stringify([
      { msgId: 100, sourceChatId: 14 }, // pre-version-tracking entry
    ])
    const out = parseSessions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].appVersion).toBeUndefined()
  })

  test('preserves lastSerial across the round-trip', () => {
    const raw = JSON.stringify([
      { msgId: 100, sourceChatId: 14, appVersion: 2.15, lastSerial: 42 },
    ])
    const out = parseSessions(raw)
    expect(out[0].lastSerial).toBe(42)
  })

  test('drops malformed entries silently', () => {
    const raw = JSON.stringify([
      { msgId: 'not a number', sourceChatId: 14 },
      { msgId: 100, sourceChatId: 14, appVersion: 2.15 }, // valid
      'random string',
      null,
    ])
    const out = parseSessions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].msgId).toBe(100)
  })

  test('non-array JSON returns empty array', () => {
    expect(parseSessions('{}')).toEqual([])
    expect(parseSessions('null')).toEqual([])
    expect(parseSessions('"string"')).toEqual([])
  })

  test('invalid JSON returns empty array', () => {
    expect(parseSessions('not json{')).toEqual([])
  })

  test('drops entries where appVersion is non-numeric', () => {
    // A corrupt persist or a hand-edit could set appVersion to a string.
    // Load that as undefined rather than poisoning the comparison.
    const raw = JSON.stringify([
      { msgId: 100, sourceChatId: 14, appVersion: 'two-point-fifteen' },
    ])
    const out = parseSessions(raw)
    expect(out).toHaveLength(1)
    expect(out[0].appVersion).toBeUndefined()
  })
})

describe('resolveMemoryBoost', () => {
  test('explicit true → on, explicit false → off (switch is authoritative)', () => {
    expect(resolveMemoryBoost(true, 'anything')).toBe('on')
    expect(resolveMemoryBoost(false, 'a warm companion who chats with you')).toBe('off')
  })
  test('undefined → falls back to classifyMemoryBoost(body)', () => {
    // conversational body → on; coding body → off (classifier behavior)
    expect(resolveMemoryBoost(undefined, 'A warm companion who remembers your day.')).toBe('on')
    expect(resolveMemoryBoost(undefined, 'Senior engineer: edit files, run tests, fix the repo.')).toBe('off')
  })
})
