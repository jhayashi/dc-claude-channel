import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setCardSessionsDir, recordCardSession, updateCardSerial, restoreCardSessions } from '../dispatcher/card-sessions.js'
import { teleportApp } from '../apps/teleport-app.js'
import { contactsApp } from '../apps/contacts-app.js'
import { createApp } from '../apps/create-app.js'
import { agentManageApp } from '../apps/agent-manage-app.js'
import { permissionsApp } from '../apps/permissions-app.js'
import * as bindings from '../bindings.js'
import * as agents from '../agents.js'

// #114: the exact reported symptom — a card opened before a restart gets
// its next tap dropped ("...: onWebXDCUpdate for unregistered msgId").
// After restoreSession, the same tap is answered.
//
// Uses the contactsApp variant of the "answers instead of dropping" proof
// (per the brief's fallback note): teleport's resume_list_request path
// throws a pre-existing, unrelated ReferenceError (`listCandidates is not
// defined` — a local var scoped to `handleResumeAttach`, not
// `onWebXDCUpdate`) when exercised directly, so it doesn't "run clean" here.
// contacts' list_contacts path proves the same symptom without that bug.

describe('card session restore (#114)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'restore-'))
    setCardSessionsDir(dir)
    // Isolate bindings/agents lookups touched by contacts' handleListContacts
    // so the test never reads the real user's home-dir state.
    bindings.setBindingsDir(join(dir, 'bindings'))
    agents.setAgentsDir(join(dir, 'agents'))
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  test('all four newer cards implement restoreSession; permissions deliberately does not', () => {
    expect(typeof teleportApp.restoreSession).toBe('function')
    expect(typeof contactsApp.restoreSession).toBe('function')
    expect(typeof createApp.restoreSession).toBe('function')
    expect(typeof agentManageApp.restoreSession).toBe('function')
    expect(permissionsApp.restoreSession).toBeUndefined()
  })

  test('restored contacts card answers a list request instead of dropping it', async () => {
    // Simulate: card registered in a previous process, dispatcher restarted.
    recordCardSession(777, 'contacts', 51)
    const registry = new Map<number, { appId: string; chatId: number; lastSerial: number }>()
    restoreCardSessions({
      apps: [contactsApp],
      register: (msgId, appId, chatId, lastSerial) => registry.set(msgId, { appId, chatId, lastSerial }),
    })
    expect(registry.get(777)).toEqual({ appId: 'contacts', chatId: 51, lastSerial: 0 })

    // The tap: a list_contacts request on the restored msgId must be answered.
    const updatesOut: any[] = []
    const ctx: any = {
      client: {
        getChatContacts: async () => [],
        getSelfAddress: async () => 'bot@example.com',
        sendWebXDCUpdate: async (_m: number, u: string) => { updatesOut.push(JSON.parse(u).payload) },
      },
      logf: () => {},
    }
    await contactsApp.onWebXDCUpdate!(777, [
      { payload: { type: 'list_contacts', senderAddr: 'x' }, serial: 1 } as never,
    ], ctx)
    expect(updatesOut.some(p => p.type === 'contacts_loaded')).toBe(true)
  })

  test('restore carries lastSerial (safety invariant)', () => {
    recordCardSession(778, 'contacts', 52)
    updateCardSerial(778, 33)
    const seen: number[] = []
    restoreCardSessions({ apps: [contactsApp], register: (_m, _a, _c, lastSerial) => seen.push(lastSerial) })
    expect(seen).toContain(33)
  })
})
