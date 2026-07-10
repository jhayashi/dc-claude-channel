import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSubagentArgs } from '../dispatcher/subagent-process.js'
import { handleListContacts } from '../apps/contacts-app.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import type { AgentDef } from '../agents.js'

// #137 test-only slice: named coverage gaps from the 2026-07-09 journey
// validation that need no production changes — the seams already existed,
// the tests were just never written.

describe('trust toggle → spawn argv (#137)', () => {
  function makeAgent(overrides: Partial<AgentDef> = {}): AgentDef {
    return {
      name: 'argv-agent',
      description: 't',
      model: 'claude-sonnet-5',
      body: 'x',
      tools: 'mcp__dc',
      ...overrides,
    } as AgentDef
  }

  test('trusted agent spawns with --permission-mode bypassPermissions', () => {
    const { args } = buildSubagentArgs({
      chatId: 1,
      agent: makeAgent({ permissionMode: 'bypassPermissions' } as Partial<AgentDef>),
    } as never)
    const idx = args.indexOf('--permission-mode')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('bypassPermissions')
  })

  test('untrusted agent spawns without --permission-mode', () => {
    const { args } = buildSubagentArgs({
      chatId: 1,
      agent: makeAgent(),
    } as never)
    expect(args.indexOf('--permission-mode')).toBe(-1)
  })
})

describe('D3 contacts picker-universe scoping (#137, v1.4.9 headline)', () => {
  let bindingsDir: string
  let contactsDir: string

  beforeEach(() => {
    bindingsDir = mkdtempSync(join(tmpdir(), 'd3-bindings-'))
    contactsDir = mkdtempSync(join(tmpdir(), 'd3-contacts-'))
    bindings.setBindingsDir(bindingsDir)
    access.setContactsAgentsDir(contactsDir)
  })

  afterEach(() => {
    for (const d of [bindingsDir, contactsDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  test("picker universe is the managed agent's chats only — no cross-agent leak", async () => {
    // agent X (dc-developer) owns chats 100+101 with contacts 11,12.
    // agent Y (librarian) owns chat 200 with contact 13. Opening the
    // contacts card from chat 100 must list 11+12 and NEVER 13.
    const now = new Date().toISOString()
    bindings.saveBinding({ chatId: 100, agentId: 'dc-developer', inheritClaudeMd: false, createdAt: now })
    bindings.saveBinding({ chatId: 101, agentId: 'dc-developer', inheritClaudeMd: false, createdAt: now })
    bindings.saveBinding({ chatId: 200, agentId: 'librarian', inheritClaudeMd: false, createdAt: now })

    const membership: Record<number, number[]> = {
      100: [1, 11],
      101: [1, 12],
      200: [1, 13],
    }
    const sent: any[] = []
    const ctx: any = {
      client: {
        getChatContacts: async (chatId: number) => membership[chatId] ?? [],
        getContact: async (id: number) => ({ displayName: `C${id}`, address: `c${id}@x.org` }),
        getSelfAddress: async () => 'bot@x.org',
        sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) },
      },
      logf: () => {},
    }
    await handleListContacts(ctx, 55 /*msgId*/, 100 /*sourceChatId*/)
    const payload = sent.find(p => p.type === 'contacts_list' || p.contacts)
    expect(payload).toBeTruthy()
    const ids = (payload.contacts as Array<{ contactId: number }>).map(c => c.contactId).sort()
    expect(ids).toEqual([11, 12])
    expect(ids).not.toContain(13)
  })

  test('unbound source chat manages the default agent (documented fallback)', async () => {
    const sent: any[] = []
    const ctx: any = {
      client: {
        getChatContacts: async () => [],
        getContact: async () => ({ displayName: 'x', address: 'x@x.org' }),
        getSelfAddress: async () => 'bot@x.org',
        sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) },
      },
      logf: () => {},
    }
    await handleListContacts(ctx, 55, 999)
    const payload = sent.find(p => p.contacts)
    expect(payload).toBeTruthy()
    // claude-code has no bound chats in this fixture → empty universe,
    // not an error and not the whole address book.
    expect(payload.contacts).toEqual([])
  })
})
