import { describe, test, expect } from 'bun:test'
import { DC_TOOLS, type ToolCtx } from '../dispatcher/dc-tools'
import { coreDispatchToolNames } from '../server'

/**
 * Build a ToolCtx whose members throw unless a test overrides them, so each
 * handler test stubs only the surface it exercises.
 */
export function makeToolCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const trap = (name: string) =>
    new Proxy({}, { get: () => () => { throw new Error(`ToolCtx.${name} not stubbed`) } })
  return {
    client: trap('client') as ToolCtx['client'],
    access: trap('access') as ToolCtx['access'],
    bindings: trap('bindings') as ToolCtx['bindings'],
    agents: trap('agents') as ToolCtx['agents'],
    logf: () => {},
    ...overrides,
  }
}

describe('DC_TOOLS registry', () => {
  test('tool names are unique', () => {
    const names = DC_TOOLS.map(t => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('every registry tool name is a valid mcp__dc identifier', () => {
    for (const t of DC_TOOLS) expect(t.name).toMatch(/^(reply|dc_[a-z_]+)$/)
  })
})

test('every DC_TOOLS tool has exactly one dispatch entry, and vice versa', () => {
  const registry = new Set(DC_TOOLS.map(t => t.name))
  const dispatch = new Set(coreDispatchToolNames())
  expect([...registry].filter(n => !dispatch.has(n))).toEqual([])
  expect([...dispatch].filter(n => !registry.has(n))).toEqual([])
})

test('reply sends to an allowed chat and returns the message id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'reply')!
  const sent: Array<[number, string]> = []
  const ctx = makeToolCtx({
    access: { isAllowed: (id: number) => id === 42 } as unknown as ToolCtx['access'],
    client: { send: async (id: number, text: string) => { sent.push([id, text]); return 7 } } as unknown as ToolCtx['client'],
  })
  const ok = await def.handler!({ chat_id: '42', text: 'hi' }, ctx)
  expect(ok).toEqual({ content: [{ type: 'text', text: 'sent (id: 7)' }] })
  expect(sent).toEqual([[42, 'hi']])
  const denied = await def.handler!({ chat_id: '99', text: 'hi' }, ctx)
  expect(denied.isError).toBe(true)
})

// ── dc_react ─────────────────────────────────────────────────────────────

test('dc_react: sends reaction to allowed chat', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_react')!
  const reacted: Array<[number, string]> = []
  const ctx = makeToolCtx({
    access: { isAllowed: (id: number) => id === 5 } as unknown as ToolCtx['access'],
    client: { sendReaction: async (msgId: number, emoji: string) => { reacted.push([msgId, emoji]) } } as unknown as ToolCtx['client'],
  })
  const ok = await def.handler!({ chat_id: '5', message_id: '101', emoji: '👍' }, ctx)
  expect(ok.isError).toBeUndefined()
  expect(ok.content[0].text).toContain('reacted 👍')
  expect(reacted).toEqual([[101, '👍']])
})

test('dc_react: rejects missing chat_id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_react')!
  const ctx = makeToolCtx({ access: { isAllowed: () => true } as unknown as ToolCtx['access'] })
  const r = await def.handler!({ chat_id: '', message_id: '1', emoji: '👍' }, ctx)
  expect(r.isError).toBe(true)
})

test('dc_react: rejects disallowed chat', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_react')!
  const ctx = makeToolCtx({ access: { isAllowed: () => false } as unknown as ToolCtx['access'] })
  const r = await def.handler!({ chat_id: '7', message_id: '1', emoji: '👍' }, ctx)
  expect(r.isError).toBe(true)
})

// ── dc_status ─────────────────────────────────────────────────────────────

test('dc_status: returns address, connected, inviteLink', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_status')!
  const ctx = makeToolCtx({
    client: { status: async () => ({ address: 'bot@example.com', connected: true, inviteLink: 'https://i.delta.chat/abc' }) } as unknown as ToolCtx['client'],
  })
  const r = await def.handler!({}, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toContain('bot@example.com')
  expect(r.content[0].text).toContain('Connected: true')
})

// ── dc_invite_link ────────────────────────────────────────────────────────

test('dc_invite_link: returns personal invite when no armed group', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_invite_link')!
  const ctx = makeToolCtx({
    access: {
      getArmedGroupChatId: () => null,
      isArmed: () => false,
    } as unknown as ToolCtx['access'],
    client: { inviteLink: async () => 'https://i.delta.chat/personal' } as unknown as ToolCtx['client'],
  })
  const r = await def.handler!({}, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toBe('https://i.delta.chat/personal')
})

test('dc_invite_link: returns group invite when armed group exists', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_invite_link')!
  const ctx = makeToolCtx({
    access: {
      getArmedGroupChatId: () => 10,
      isArmed: () => true,
    } as unknown as ToolCtx['access'],
    client: {
      getGroupInviteLink: async (id: number) => `https://i.delta.chat/group/${id}`,
      inviteLink: async () => 'https://i.delta.chat/personal',
    } as unknown as ToolCtx['client'],
  })
  const r = await def.handler!({}, ctx)
  expect(r.content[0].text).toBe('https://i.delta.chat/group/10')
})

// ── dc_access_list ────────────────────────────────────────────────────────

test('dc_access_list: returns list of allowed chats', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_access_list')!
  const ctx = makeToolCtx({
    access: { allowedChats: () => [1, 2, 3] } as unknown as ToolCtx['access'],
  })
  const r = await def.handler!({}, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toContain('Approved chats')
})

test('dc_access_list: returns empty message when no chats', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_access_list')!
  const ctx = makeToolCtx({
    access: { allowedChats: () => [] } as unknown as ToolCtx['access'],
  })
  const r = await def.handler!({}, ctx)
  expect(r.content[0].text).toContain('No approved chats')
})

// ── dc_access_revoke ──────────────────────────────────────────────────────

test('dc_access_revoke: revokes a valid chat_id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_access_revoke')!
  const removed: number[] = []
  const ctx = makeToolCtx({
    access: { removeChat: (id: number) => { removed.push(id) } } as unknown as ToolCtx['access'],
  })
  const r = await def.handler!({ chat_id: '42' }, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toContain('42')
  expect(removed).toEqual([42])
})

test('dc_access_revoke: rejects missing chat_id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_access_revoke')!
  const ctx = makeToolCtx({ access: {} as unknown as ToolCtx['access'] })
  const r = await def.handler!({}, ctx)
  expect(r.isError).toBe(true)
})

// ── dc_get_agent_prompt ───────────────────────────────────────────────────

test('dc_get_agent_prompt: returns agent name and prompt', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_get_agent_prompt')!
  const ctx = makeToolCtx({
    bindings: {
      resolveChat: (id: number) => id === 7 ? { agent: { name: 'my-agent', body: 'do stuff' } } : null,
    } as unknown as ToolCtx['bindings'],
  })
  const r = await def.handler!({ chat_id: '7' }, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toContain('my-agent')
  expect(r.content[0].text).toContain('do stuff')
})

test('dc_get_agent_prompt: returns no-agent message when unbound', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_get_agent_prompt')!
  const ctx = makeToolCtx({
    bindings: { resolveChat: () => null } as unknown as ToolCtx['bindings'],
  })
  const r = await def.handler!({ chat_id: '99' }, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toContain('No agent configured')
})

test('dc_get_agent_prompt: rejects missing chat_id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_get_agent_prompt')!
  const ctx = makeToolCtx({ bindings: {} as unknown as ToolCtx['bindings'] })
  const r = await def.handler!({}, ctx)
  expect(r.isError).toBe(true)
})

// ── dc_check_contact ──────────────────────────────────────────────────────

test('dc_check_contact: returns contact info for a permissioned contact', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_check_contact')!
  const ctx = makeToolCtx({
    access: {
      DEFAULT_AGENT_ID: 'default',
      isContactPermissioned: (_agentId: string, _contactId: number) => true,
      loadContact: (_agentId: string, _contactId: number) => ({ firstPairedAt: '2026-01-01T00:00:00.000Z' }),
      chatsForOwner: (_contactId: number) => [1, 2],
      firstPermissionedContact: (_chatId: number) => 5,
    } as unknown as ToolCtx['access'],
    client: {
      getContact: async (_id: number) => ({ displayName: 'Alice', name: 'Alice', address: 'alice@delta.chat' }),
    } as unknown as ToolCtx['client'],
  })
  const r = await def.handler!({ contact_id: '5' }, ctx)
  expect(r.isError).toBeUndefined()
  const parsed = JSON.parse(r.content[0].text)
  expect(parsed.contactId).toBe(5)
  expect(parsed.permissioned).toBe(true)
  expect(parsed.displayName).toBe('Alice')
  expect(parsed.pairedChatCount).toBe(2)
})

test('dc_check_contact: rejects missing contact_id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_check_contact')!
  const ctx = makeToolCtx({ access: {} as unknown as ToolCtx['access'] })
  const r = await def.handler!({}, ctx)
  expect(r.isError).toBe(true)
})

// ── dc_exit_session ───────────────────────────────────────────────────────

test('dc_exit_session: registered as infrastructure tool (handler never invoked in tests)', () => {
  // NEVER call this handler in tests: it resolves this process's grandparent
  // via /proc and fires a real SIGTERM at it 500ms later. Under `bun test`
  // that pid is not a claude terminal — it's the test runner's ancestor
  // (the systemd --user manager, tmux, or the spawning subagent), and the
  // signal tears it down (2026-07-16: killed the whole user session, twice).
  const def = DC_TOOLS.find(t => t.name === 'dc_exit_session')!
  expect(def).toBeDefined()
  expect(def.requiresCapability).toBe('infrastructure')
  expect(typeof def.handler).toBe('function')
})

// ── dc_chat_history ───────────────────────────────────────────────────────

test('dc_chat_history: returns formatted message lines', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_chat_history')!
  const ctx = makeToolCtx({
    access: {
      isAllowed: (id: number) => id === 10,
      DEFAULT_AGENT_ID: 'default',
      isContactTrustedForContent: (_agentId: string, _contactId: number) => true,
    } as unknown as ToolCtx['access'],
    client: {
      getChatHistory: async (_chatId: number, _count: number) => [
        { fromId: 5, text: 'Hello', timestamp: new Date(1000000), id: 1, senderName: 'Alice' },
      ],
    } as unknown as ToolCtx['client'],
    bindings: { getBinding: () => null, getBindingAgentId: () => 'default' } as unknown as ToolCtx['bindings'],
  })
  const r = await def.handler!({ chat_id: '10', count: 5 }, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text.length).toBeGreaterThan(0)
})

test('dc_chat_history: rejects inaccessible chat', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_chat_history')!
  const ctx = makeToolCtx({
    access: { isAllowed: () => false } as unknown as ToolCtx['access'],
  })
  const r = await def.handler!({ chat_id: '99' }, ctx)
  expect(r.isError).toBe(true)
})

// ── dc_download_attachment ────────────────────────────────────────────────

test('dc_download_attachment: returns file path for permitted sender', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_download_attachment')!
  const ctx = makeToolCtx({
    access: {
      DEFAULT_AGENT_ID: 'default',
      isContactTrustedForContent: (_agentId: string, _contactId: number) => true,
    } as unknown as ToolCtx['access'],
    client: {
      downloadMessage: async (_id: number) => ({ file: '/tmp/attachment.jpg', fromId: 5, chatId: 10 }),
    } as unknown as ToolCtx['client'],
    bindings: { getBinding: () => null, getBindingAgentId: () => 'default' } as unknown as ToolCtx['bindings'],
  })
  const r = await def.handler!({ message_id: '77' }, ctx)
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toBe('/tmp/attachment.jpg')
})

test('dc_download_attachment: blocks unpermissioned sender by default', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_download_attachment')!
  const ctx = makeToolCtx({
    access: {
      DEFAULT_AGENT_ID: 'default',
      isContactTrustedForContent: (_agentId: string, _contactId: number) => false,
    } as unknown as ToolCtx['access'],
    client: {
      downloadMessage: async (_id: number) => ({ file: '/tmp/evil.pdf', fromId: 999, chatId: 10 }),
    } as unknown as ToolCtx['client'],
    bindings: { getBinding: () => null, getBindingAgentId: () => 'default' } as unknown as ToolCtx['bindings'],
  })
  const r = await def.handler!({ message_id: '88' }, ctx)
  expect(r.isError).toBe(true)
})

test('dc_download_attachment: rejects missing message_id', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_download_attachment')!
  const ctx = makeToolCtx({ client: {} as unknown as ToolCtx['client'] })
  const r = await def.handler!({}, ctx)
  expect(r.isError).toBe(true)
})

// ── dc_access_arm_pairing ─────────────────────────────────────────────────

test('dc_access_arm_pairing: creates group and arms pairing', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_access_arm_pairing')!
  const deletedChats: number[] = []
  let armedWith: number | undefined
  let groupCreated = false
  const ctx = makeToolCtx({
    access: {
      getArmedGroupChatId: () => null,
      isArmed: () => false,
      armPairing: (id: number) => { armedWith = id },
      getArmedUntil: () => Date.now() + 300_000,
    } as unknown as ToolCtx['access'],
    client: {
      deleteChat: async (id: number) => { deletedChats.push(id) },
      createGroup: async (_name: string) => { groupCreated = true; return 55 },
      setChatProfileImage: async () => {},
    } as unknown as ToolCtx['client'],
    agents: {
      ensureDefaultAgent: () => ({ name: 'default', body: '', 'x-dc-icon': undefined }),
    } as unknown as ToolCtx['agents'],
  })
  const r = await def.handler!({}, ctx)
  expect(r.content[0].text).toContain('Pairing armed')
  expect(deletedChats).toEqual([]) // no previous group
  expect(groupCreated).toBe(true)
  expect(armedWith).toBe(55)
})

test('dc_access_arm_pairing: deletes previous armed group before re-arming', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_access_arm_pairing')!
  const deletedChats: number[] = []
  const ctx = makeToolCtx({
    access: {
      getArmedGroupChatId: () => 30,
      isArmed: () => true,
      armPairing: (_id: number) => {},
      getArmedUntil: () => Date.now() + 300_000,
    } as unknown as ToolCtx['access'],
    client: {
      deleteChat: async (id: number) => { deletedChats.push(id) },
      createGroup: async (_name: string) => 56,
      setChatProfileImage: async () => {},
    } as unknown as ToolCtx['client'],
    agents: {
      ensureDefaultAgent: () => ({ name: 'default', body: '' }),
    } as unknown as ToolCtx['agents'],
  })
  const r = await def.handler!({}, ctx)
  expect(r.content[0].text).toContain('Pairing armed')
  expect(deletedChats).toContain(30)
})

// ── dc_search_messages ────────────────────────────────────────────────────

function searchCtx(over: Partial<ToolCtx> = {}): ToolCtx {
  return makeToolCtx({
    access: { isAllowed: (id: number) => id === 10, isContactTrustedForContent: () => true } as unknown as ToolCtx['access'],
    bindings: { getBindingAgentId: () => 'default', getBinding: () => null } as unknown as ToolCtx['bindings'],
    client: {
      searchMessageIds: async () => [1],
      getHistoryMessages: async () => [{ id: 1, chatId: 10, fromId: 5, senderName: 'Alice', text: 'the thing you forgot', timestamp: new Date(1_000_000) }],
    } as unknown as ToolCtx['client'],
    ...over,
  })
}

test('dc_search_messages: returns matching snippets for a permitted chat', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_search_messages')!
  const r = await def.handler!({ chat_id: '10', query: 'forgot' }, searchCtx())
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toContain('forgot')
})

test('dc_search_messages: defaults to the current chat when chat_id omitted', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_search_messages')!
  const r = await def.handler!({ query: 'forgot' }, searchCtx(), 10) // callerChatId = 10
  expect(r.isError).toBeUndefined()
  expect(r.content[0].text).toContain('forgot')
})

test('dc_search_messages: rejects empty query', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_search_messages')!
  const r = await def.handler!({ chat_id: '10', query: '  ' }, searchCtx())
  expect(r.isError).toBe(true)
})

test('dc_search_messages: rejects inaccessible chat', async () => {
  const def = DC_TOOLS.find(t => t.name === 'dc_search_messages')!
  const ctx = searchCtx({ access: { isAllowed: () => false } as unknown as ToolCtx['access'] })
  const r = await def.handler!({ chat_id: '99', query: 'x' }, ctx)
  expect(r.isError).toBe(true)
})
