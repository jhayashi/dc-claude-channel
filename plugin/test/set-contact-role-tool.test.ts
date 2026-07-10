import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contactsApp } from '../apps/contacts-app.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'

// #133: dc_set_contact_role — the authenticated, directly-callable role
// assignment (dc_rebind_chat pattern). This is the recovery path for
// multi-human groups, where the contacts card's tap-driven assign_role is
// always §6-refused. Deliberately NO auth callback: the tool is reachable
// only via a chat message whose fromId the capability gate has already
// authorized (requiresCapability: 'infrastructure').

const GROUP_CHAT = 77
const ALICE = 21

function makeCtx() {
  const sent: string[] = []
  return {
    ctx: {
      client: {
        getContact: async (id: number) => ({ displayName: `Contact ${id}`, address: `c${id}@x.org` }),
        lookupContactByAddr: async () => null,
      },
      logf: () => {},
    } as never,
    sent,
  }
}

describe('dc_set_contact_role (#133)', () => {
  let bindingsDir: string
  let contactsDir: string

  beforeEach(() => {
    bindingsDir = mkdtempSync(join(tmpdir(), 'scr-bindings-'))
    contactsDir = mkdtempSync(join(tmpdir(), 'scr-contacts-'))
    bindings.setBindingsDir(bindingsDir)
    access.setContactsAgentsDir(contactsDir)
  })

  afterEach(() => {
    for (const d of [bindingsDir, contactsDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  test('tool is declared with infrastructure capability and no auth callback', () => {
    const def = contactsApp.tools().find(t => t.name === 'dc_set_contact_role')
    expect(def).toBeTruthy()
    expect(def!.requiresCapability).toBe('infrastructure')
    expect(def!.inputSchema.required).toEqual(
      expect.arrayContaining(['chat_id', 'contact_id', 'role']),
    )
  })

  test('E5 regression: assigns under the CHAT\'s bound agent — works from the group itself', async () => {
    // The card's refusal copy sent users to a 1:1 whose bound agent (usually
    // claude-code) couldn't see the group's contacts. The tool resolves the
    // agent from the chat the message was sent in, so saying it in group G
    // (bound to agent X) writes to X's sidecar.
    bindings.saveBinding({ chatId: GROUP_CHAT, agentId: 'olliespa', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    const { ctx } = makeCtx()
    const res = await contactsApp.callTool!('dc_set_contact_role', {
      chat_id: String(GROUP_CHAT), contact_id: String(ALICE), role: 'family-member',
    }, ctx)
    expect(res!.isError).toBeUndefined()
    const record = access.loadContact('olliespa', ALICE)
    expect(record?.role).toBe('family-member')
    expect(access.getCapabilitiesFor('olliespa', ALICE)).toContain('chat')
    // and NOT under the default agent
    expect(access.loadContact('claude-code', ALICE)).toBeNull()
  })

  test('creates a record for a first-time contact (Option B)', async () => {
    bindings.saveBinding({ chatId: GROUP_CHAT, agentId: 'olliespa', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    const { ctx } = makeCtx()
    await contactsApp.callTool!('dc_set_contact_role', {
      chat_id: String(GROUP_CHAT), contact_id: String(ALICE), role: 'guest',
    }, ctx)
    const record = access.loadContact('olliespa', ALICE)
    expect(record).not.toBeNull()
    expect(record!.role).toBe('guest')
    expect(record!.firstPairedAt).toBeTruthy()
  })

  test('no-permissions role empties capabilities', async () => {
    bindings.saveBinding({ chatId: GROUP_CHAT, agentId: 'olliespa', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    const { ctx } = makeCtx()
    await contactsApp.callTool!('dc_set_contact_role', {
      chat_id: String(GROUP_CHAT), contact_id: String(ALICE), role: 'no-permissions',
    }, ctx)
    expect(access.getCapabilitiesFor('olliespa', ALICE)).toEqual([])
  })

  test('rejects an unknown role with the valid list', async () => {
    const { ctx } = makeCtx()
    const res = await contactsApp.callTool!('dc_set_contact_role', {
      chat_id: String(GROUP_CHAT), contact_id: String(ALICE), role: 'admin',
    }, ctx)
    expect(res!.isError).toBe(true)
    const text = (res!.content[0] as { text: string }).text
    expect(text).toContain('subscriber')
    expect(text).toContain('no-permissions')
  })

  test('rejects missing args', async () => {
    const { ctx } = makeCtx()
    const res = await contactsApp.callTool!('dc_set_contact_role', {
      chat_id: String(GROUP_CHAT), role: 'guest',
    }, ctx)
    expect(res!.isError).toBe(true)
  })

  test('confirmation names the contact, role, and agent', async () => {
    bindings.saveBinding({ chatId: GROUP_CHAT, agentId: 'olliespa', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    const { ctx } = makeCtx()
    const res = await contactsApp.callTool!('dc_set_contact_role', {
      chat_id: String(GROUP_CHAT), contact_id: String(ALICE), role: 'family-member',
    }, ctx)
    const text = (res!.content[0] as { text: string }).text
    expect(text).toContain(`Contact ${ALICE}`)
    expect(text).toContain('family-member')
    expect(text).toContain('olliespa')
  })
})
