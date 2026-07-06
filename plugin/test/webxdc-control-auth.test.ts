import { describe, test, expect } from 'bun:test'
import { isControlCommandAuthorized, countHumanMembers, type ControlAuthDeps } from '../access/webxdc-control-auth.js'

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

describe('countHumanMembers', () => {
  // members: 1 = CONTACT_SELF (bot); the rest are per-id bot flags.
  const mk = (members: number[], bots: Record<number, boolean>) =>
    countHumanMembers(
      async () => members,
      async (id) => bots[id] ?? false,
      42,
    )

  test('solo chat (owner + bot only) → 1 human', async () => {
    expect(await mk([1, 7], {})).toBe(1)
  })

  test('owner + Claude + another AGENT/bot → 1 human (bots excluded)', async () => {
    // The regression: World Cup Pool = owner(7) + two bot agents(20,21) read
    // as 3 "humans" under the old count and wrongly tripped needs-confirmation.
    expect(await mk([1, 7, 20, 21], { 20: true, 21: true })).toBe(1)
  })

  test('genuine multi-human group (two people) → 2 humans', async () => {
    expect(await mk([1, 7, 8], {})).toBe(2)
  })

  test('getContact failure defaults to human (fail-safe: does not under-count)', async () => {
    const n = await countHumanMembers(
      async () => [1, 7, 8],
      async (id) => { if (id === 8) throw new Error('no such contact'); return false },
      42,
    )
    expect(n).toBe(2)
  })
})
