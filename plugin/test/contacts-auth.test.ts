import { test, expect } from 'bun:test'
import { handleAssignRole } from '../apps/contacts-app.js'

test('assign_role refused when not authorized → emits role_assign_err, no write', async () => {
  const sent: any[] = []
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) }, getContact: async () => ({}), lookupContactByAddr: async () => null },
    logf: () => {},
  }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleAssignRole(ctx, 99, 42, 11, 'subscriber', 'hash', auth)
  expect(sent.some(p => p.type === 'role_assign_err')).toBe(true)
  expect(sent.some(p => p.type === 'role_assigned')).toBe(false)
})

test('multi-human refusal copy describes the message-lane recovery, not the 1:1 card (#133)', async () => {
  const sent: any[] = []
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) }, getContact: async () => ({}), lookupContactByAddr: async () => null },
    logf: () => {},
  }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleAssignRole(ctx, 99, 42, 11, 'subscriber', 'hash', auth)
  const err = sent.find(p => p.type === 'role_assign_err')
  // The recovery must be the authenticated chat message (routes to
  // dc_set_contact_role). The old "open this card from your 1:1" advice
  // broke on v1.4.9 per-agent picker scoping — the 1:1's agent usually
  // can't even see this group's contacts.
  expect(err.message).toContain('as a normal message')
  expect(err.message).not.toContain('1:1')
})
