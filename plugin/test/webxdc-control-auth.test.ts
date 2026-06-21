import { describe, test, expect } from 'bun:test'
import { isControlCommandAuthorized, type ControlAuthDeps } from '../access/webxdc-control-auth.js'

function deps(over: Partial<{ humans: number; owner: number | null }>): ControlAuthDeps {
  return {
    humanMemberCount: async () => over.humans ?? 1,
    owner: () => (over.owner === undefined ? 7 : over.owner),
  }
}

describe('isControlCommandAuthorized', () => {
  test('solo group (1 human = owner only) → authorized directly', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 1 }))
    expect(r).toEqual({ ok: true })
  })

  test('no owner → refused', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 1, owner: null }))
    expect(r).toEqual({ ok: false, reason: 'no-owner' })
  })

  test('multi-human group → always needs-confirmation (webXDC taps are unauthenticated)', async () => {
    // GH #114: webXDC taps don't update _currentDriver; any driver value reflects
    // only the last message sender, so we can never authenticate the tap author.
    const r = await isControlCommandAuthorized(42, deps({ humans: 3 }))
    expect(r).toEqual({ ok: false, reason: 'needs-confirmation' })
  })

  test('multi-human group with 2 members → still needs-confirmation', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 2 }))
    expect(r).toEqual({ ok: false, reason: 'needs-confirmation' })
  })
})
