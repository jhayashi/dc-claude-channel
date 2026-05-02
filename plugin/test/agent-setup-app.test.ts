import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLeavesDir, getDefaultCatalog } from '../leaves.js'
import {
  composeIdentityPreamble,
  composeAgentName,
  createReuseChat,
  resolveAttachAgent,
  handleListContacts,
  handleAssignRole,
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
    // Force-remove the agent's directory manually.
    rmSync(join(agentsDir, agents.DEFAULT_AGENT_ID), { recursive: true, force: true })
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).toBeNull()
    const reseeded = agents.ensureDefaultAgent()
    expect(reseeded.id).toBe(agents.DEFAULT_AGENT_ID)
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).not.toBeNull()
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

  beforeEach(() => {
    tmpAccess = mkdtempSync(join(tmpdir(), 'dc-cm-access-'))
    tmpAgents = mkdtempSync(join(tmpdir(), 'dc-cm-agents-'))
    tmpEvents = mkdtempSync(join(tmpdir(), 'dc-cm-events-'))
    access.setApprovedDir(tmpAccess)
    access.setContactsAgentsDir(tmpAgents)
    setEventDir(tmpEvents)
  })

  afterEach(() => {
    try { rmSync(tmpAccess, { recursive: true, force: true }) } catch {}
    try { rmSync(tmpAgents, { recursive: true, force: true }) } catch {}
    try { rmSync(tmpEvents, { recursive: true, force: true }) } catch {}
  })

  function makeCtx(lookupResult: number | null = null): {
    ctx: AppContext
    sendWebXDCUpdate: ReturnType<typeof mock>
    lookupContactByAddr: ReturnType<typeof mock>
  } {
    const sendWebXDCUpdate = mock(async () => {})
    const lookupContactByAddr = mock(async (_addr: string) => lookupResult)
    const client = { sendWebXDCUpdate, lookupContactByAddr } as unknown as AppContext['client']
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
    return JSON.parse(sendWebXDCUpdate.mock.calls[0][1] as string)
  }

  function readPermissionsLog(): unknown {
    const files = readdirSync(tmpEvents).filter(f => f.startsWith('permissions-'))
    if (files.length === 0) return null
    return JSON.parse(readFileSync(join(tmpEvents, files[0]), 'utf8').trim())
  }

  // ── handleListContacts ───────────────────────────────────────────────────

  test('handleListContacts sends contacts_loaded with all contacts', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    access.recordContactPair(access.DEFAULT_AGENT_ID, 6, 'Bob')
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleListContacts(ctx, 99)

    expect(sendWebXDCUpdate).toHaveBeenCalledTimes(1)
    expect(sendWebXDCUpdate.mock.calls[0][0]).toBe(99)
    const update = capturedUpdate(sendWebXDCUpdate) as { type: string; contacts: { contactId: number }[] }
    expect(update.type).toBe('contacts_loaded')
    expect(update.contacts.map(c => c.contactId).sort()).toEqual([5, 6])
  })

  test('handleListContacts with no contacts sends empty array', async () => {
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleListContacts(ctx, 99)

    const update = capturedUpdate(sendWebXDCUpdate) as { contacts: unknown[] }
    expect(update.contacts).toEqual([])
  })

  // ── handleAssignRole ─────────────────────────────────────────────────────

  test('handleAssignRole updates contact role on disk', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx } = makeCtx()

    await handleAssignRole(ctx, 99, 5, 'family-member', null)

    expect(access.loadContact(access.DEFAULT_AGENT_ID, 5)?.role).toBe('family-member')
  })

  test('handleAssignRole sends role_assigned with updated contact', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleAssignRole(ctx, 99, 5, 'trusted-agent', null)

    expect(sendWebXDCUpdate).toHaveBeenCalledTimes(1)
    const update = capturedUpdate(sendWebXDCUpdate) as { type: string; contact: { contactId: number; role: string } }
    expect(update.type).toBe('role_assigned')
    expect(update.contact.contactId).toBe(5)
    expect(update.contact.role).toBe('trusted-agent')
  })

  test('handleAssignRole resolves assignerContactId via lookupContactByAddr', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx, lookupContactByAddr } = makeCtx(42)

    await handleAssignRole(ctx, 99, 5, 'family-member', 'alice@nine.testrun.org')

    expect(lookupContactByAddr).toHaveBeenCalledWith('alice@nine.testrun.org')
    const entry = readPermissionsLog() as { assignerContactId: number; reason: string }
    expect(entry.assignerContactId).toBe(42)
    expect(entry.reason).toBe('picked')
  })

  test('handleAssignRole logs null assignerContactId when address not in DC contacts', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx } = makeCtx(null)

    await handleAssignRole(ctx, 99, 5, 'family-member', 'unknown@example.com')

    const entry = readPermissionsLog() as { assignerContactId: null }
    expect(entry.assignerContactId).toBeNull()
  })

  test('handleAssignRole logs RoleAssignmentEvent with previousRole', async () => {
    access.setContactRole(access.DEFAULT_AGENT_ID, 5, 'subscriber', 'Alice')
    const { ctx } = makeCtx()

    await handleAssignRole(ctx, 99, 5, 'family-member', null)

    const entry = readPermissionsLog() as { assignedRole: string; previousRole: string }
    expect(entry.assignedRole).toBe('family-member')
    expect(entry.previousRole).toBe('subscriber')
  })

  test('handleAssignRole with unknown contactId is a no-op', async () => {
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleAssignRole(ctx, 99, 999, 'family-member', null)

    expect(sendWebXDCUpdate).not.toHaveBeenCalled()
    expect(readPermissionsLog()).toBeNull()
  })

  test('handleAssignRole with null role is a no-op', async () => {
    access.recordContactPair(access.DEFAULT_AGENT_ID, 5, 'Alice')
    const { ctx, sendWebXDCUpdate } = makeCtx()

    await handleAssignRole(ctx, 99, 5, null as unknown as string, null)

    expect(sendWebXDCUpdate).not.toHaveBeenCalled()
  })
})
