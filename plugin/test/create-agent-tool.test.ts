import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleCreateAgentTool, type CreateAgentToolDeps } from '../dispatcher/create-agent-tool.js'
import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'

// #129 regression suite. The critical assertion: a chat created by
// dc_create_agent must be immediately usable — the owner's contact record
// must exist in the NEW agent's sidecar, or the routing gate
// (getCapabilitiesFor(bindingAgentId, fromId).length > 0) silently drops
// every message until the next dispatcher restart backfills it.

const USER_CONTACT = 11
const SOURCE_CHAT = 5
const NEW_GROUP = 60

function makeDeps(overrides: Partial<CreateAgentToolDeps> = {}): {
  deps: CreateAgentToolDeps
  calls: Record<string, unknown[][]>
} {
  const calls: Record<string, unknown[][]> = {
    createGroup: [], addContactToChat: [], addChat: [], decorate: [],
  }
  const deps: CreateAgentToolDeps = {
    getChatContacts: async () => [1, USER_CONTACT],
    createGroup: async (name: string) => { calls.createGroup.push([name]); return NEW_GROUP },
    addContactToChat: async (chatId: number, contactId: number) => { calls.addContactToChat.push([chatId, contactId]) },
    addChat: (chatId: number, contactId: number) => { calls.addChat.push([chatId, contactId]) },
    decorate: async (groupId: number, agentName: string) => { calls.decorate.push([groupId, agentName]) },
    logf: () => {},
    ...overrides,
  }
  return { deps, calls }
}

describe('dc_create_agent handler (#129)', () => {
  let agentsDir: string
  let bindingsDir: string
  let contactsDir: string

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'cat-agents-'))
    bindingsDir = mkdtempSync(join(tmpdir(), 'cat-bindings-'))
    contactsDir = mkdtempSync(join(tmpdir(), 'cat-contacts-'))
    agents.setAgentsDir(agentsDir)
    bindings.setBindingsDir(bindingsDir)
    access.setContactsAgentsDir(contactsDir)
  })

  afterEach(() => {
    for (const d of [agentsDir, bindingsDir, contactsDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  test('created chat is immediately usable: owner has caps under the new agent', async () => {
    const { deps } = makeDeps()
    const res = await handleCreateAgentTool(deps, {
      name: 'Tax Helper',
      prompt: 'You help with taxes.',
      user_chat_id: String(SOURCE_CHAT),
    })
    expect(res.isError).toBeUndefined()
    const text = (res.content[0] as { text: string }).text
    const agentName = /agent_id=([\w-]+)/.exec(text)?.[1]
    expect(agentName).toBeTruthy()
    // The #129 regression: without recordContactPair, this is [] and the
    // routing gate drops every message into the new chat.
    const caps = access.getCapabilitiesFor(agentName!, USER_CONTACT)
    expect(caps.length).toBeGreaterThan(0)
  })

  test('binds the new group to the created agent', async () => {
    const { deps, calls } = makeDeps()
    const res = await handleCreateAgentTool(deps, {
      name: 'Tax Helper',
      prompt: 'You help with taxes.',
      user_chat_id: String(SOURCE_CHAT),
    })
    const text = (res.content[0] as { text: string }).text
    const agentName = /agent_id=([\w-]+)/.exec(text)![1]
    expect(bindings.getBindingAgentId(NEW_GROUP)).toBe(agentName)
    expect(calls.createGroup).toEqual([['Tax Helper']])
    expect(calls.addContactToChat).toEqual([[NEW_GROUP, USER_CONTACT]])
    expect(calls.addChat).toEqual([[NEW_GROUP, USER_CONTACT]])
    const saved = agents.getAgent(agentName)
    expect(saved).not.toBeNull()
    expect(saved!['x-dc-display-name']).toBe('Tax Helper')
  })

  test('missing args is a tool error', async () => {
    const { deps } = makeDeps()
    const res = await handleCreateAgentTool(deps, { name: 'X', prompt: '', user_chat_id: '5' })
    expect(res.isError).toBe(true)
  })

  test('no non-bot contact in source chat is a tool error', async () => {
    const { deps } = makeDeps({ getChatContacts: async () => [1] })
    const res = await handleCreateAgentTool(deps, {
      name: 'X', prompt: 'p', user_chat_id: '5',
    })
    expect(res.isError).toBe(true)
  })
})
