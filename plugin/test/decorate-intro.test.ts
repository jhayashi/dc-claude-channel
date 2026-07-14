import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { decorateAgentChat, rebindChat, createReuseChat } from '../apps/agent-setup-app.js'
import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'

// #139: the greeting must match what actually happened. decorateAgentChat
// previously hard-coded `Hi! This is your new "X" agent` for EVERY path —
// switching to or reusing an existing agent read like a duplicate had been
// created. Per-path copy assertions (the #134 lesson) pin each context.

function makeCtx() {
  const sent: Array<{ chatId: number; text: string }> = []
  const ctx = {
    client: {
      send: async (chatId: number, text: string) => { sent.push({ chatId, text }); return 1 },
      setChatProfileImage: async () => {},
      createGroup: async () => 900,
      addContactToChat: async () => {},
      setChatName: async () => {},
    },
    logf: () => {},
    evictSubagent: async () => {},
  } as never
  return { ctx, sent }
}

function agentDef(): agents.AgentDef {
  return agents.getAgent('intro-agent')!
}

describe('decorateAgentChat intro contexts (#139)', () => {
  let agentsDir: string
  let bindingsDir: string
  let contactsDir: string

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'intro-agents-'))
    bindingsDir = mkdtempSync(join(tmpdir(), 'intro-bindings-'))
    contactsDir = mkdtempSync(join(tmpdir(), 'intro-contacts-'))
    agents.setAgentsDir(agentsDir)
    bindings.setBindingsDir(bindingsDir)
    access.setContactsAgentsDir(contactsDir)
    agents.saveAgent({
      name: 'intro-agent', description: 't', model: 'claude-sonnet-5',
      body: 'x', 'x-dc-display-name': 'Intro Agent',
    } as agents.AgentDef)
  })

  afterEach(() => {
    for (const d of [agentsDir, bindingsDir, contactsDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  test("'created' keeps the original copy", async () => {
    const { ctx, sent } = makeCtx()
    await decorateAgentChat(ctx, 7, agentDef(), 'created')
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain('your new "Intro Agent" agent')
  })

  test("default intro is 'created' (back-compat)", async () => {
    const { ctx, sent } = makeCtx()
    await decorateAgentChat(ctx, 7, agentDef())
    expect(sent[0].text).toContain('your new')
  })

  test("'reused' says existing, never new", async () => {
    const { ctx, sent } = makeCtx()
    await decorateAgentChat(ctx, 7, agentDef(), 'reused')
    expect(sent.length).toBe(1)
    expect(sent[0].text).toContain('existing "Intro Agent" agent')
    expect(sent[0].text).not.toContain('new "Intro Agent"')
  })

  test("'switched' names the takeover and the fresh conversation", async () => {
    const { ctx, sent } = makeCtx()
    await decorateAgentChat(ctx, 7, agentDef(), 'switched')
    expect(sent[0].text).toContain('now runs your "Intro Agent" agent')
    expect(sent[0].text).toContain('fresh conversation')
    expect(sent[0].text).not.toContain('new "Intro Agent"')
  })

  test("'switched-kept' names the continuation", async () => {
    const { ctx, sent } = makeCtx()
    await decorateAgentChat(ctx, 7, agentDef(), 'switched-kept')
    expect(sent[0].text).toContain('now runs your "Intro Agent" agent')
    expect(sent[0].text).toContain('continuing this conversation')
  })

  test("'none' sets the badge but sends no message", async () => {
    const { ctx, sent } = makeCtx()
    await decorateAgentChat(ctx, 7, agentDef(), 'none')
    expect(sent.length).toBe(0)
  })
})

describe('call-path intros (#139)', () => {
  let agentsDir: string
  let bindingsDir: string
  let contactsDir: string

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'intro2-agents-'))
    bindingsDir = mkdtempSync(join(tmpdir(), 'intro2-bindings-'))
    contactsDir = mkdtempSync(join(tmpdir(), 'intro2-contacts-'))
    agents.setAgentsDir(agentsDir)
    bindings.setBindingsDir(bindingsDir)
    access.setContactsAgentsDir(contactsDir)
    agents.saveAgent({
      name: 'intro-agent', description: 't', model: 'claude-sonnet-5',
      body: 'x', 'x-dc-display-name': 'Intro Agent',
    } as agents.AgentDef)
    agents.saveAgent({
      name: 'other-agent', description: 't', model: 'claude-sonnet-5', body: 'x',
    } as agents.AgentDef)
  })

  afterEach(() => {
    for (const d of [agentsDir, bindingsDir, contactsDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  test('rebindChat greets as a switch (fresh), never as new', async () => {
    bindings.saveBinding({ chatId: 70, agentId: 'other-agent', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    const { ctx, sent } = makeCtx()
    await rebindChat(ctx, 70, agents.getAgent('intro-agent')!)
    const intro = sent.find(s => s.text.includes('Intro Agent'))
    expect(intro, 'rebind must greet').toBeTruthy()
    expect(intro!.text).toContain('now runs')
    expect(intro!.text).toContain('fresh conversation')
    expect(intro!.text).not.toContain('your new')
  })

  test('rebindChat with keepContext greets as a continuation', async () => {
    bindings.saveBinding({ chatId: 71, agentId: 'other-agent', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    const { ctx, sent } = makeCtx()
    await rebindChat(ctx, 71, agents.getAgent('intro-agent')!, { keepContext: true })
    const intro = sent.find(s => s.text.includes('Intro Agent'))
    expect(intro!.text).toContain('continuing this conversation')
  })

  test('createReuseChat greets as existing, never as new', async () => {
    const { ctx, sent } = makeCtx()
    await createReuseChat(ctx, agents.getAgent('intro-agent')!, 11)
    const intro = sent.find(s => s.text.includes('Intro Agent'))
    expect(intro, 'reuse must greet').toBeTruthy()
    expect(intro!.text).toContain('existing')
    expect(intro!.text).not.toContain('your new')
  })
})
