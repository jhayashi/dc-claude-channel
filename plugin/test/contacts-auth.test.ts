import { test, expect } from 'bun:test'
import { handleAssignRole } from '../apps/agent-setup-app.js'

test('assign_role refused when not authorized → emits role_assign_err, no write', async () => {
  const sent: any[] = []
  let wrote = false
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) }, getContact: async () => ({}), lookupContactByAddr: async () => null },
    logf: () => {},
  }
  // Spy: if setContactRole were called, wrote=true — but auth refuses first.
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleAssignRole(ctx, 99, 42, 11, 'subscriber', 'hash', auth)
  expect(sent.some(p => p.type === 'role_assign_err')).toBe(true)
  expect(sent.some(p => p.type === 'role_assigned')).toBe(false)
})
