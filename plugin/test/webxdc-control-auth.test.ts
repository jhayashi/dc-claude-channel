import { describe, test, expect } from 'bun:test'
import { isControlCommandAuthorized, type ControlAuthDeps } from '../access/webxdc-control-auth.js'

function deps(over: Partial<{ humans: number; owner: number | null; driver: number | null }>): ControlAuthDeps {
  return {
    humanMemberCount: async () => over.humans ?? 1,
    owner: () => (over.owner === undefined ? 7 : over.owner),
    currentDriver: () => (over.driver === undefined ? null : over.driver),
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

  test('multi-human group, last message from owner → authorized', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 3, owner: 7, driver: 7 }))
    expect(r).toEqual({ ok: true })
  })

  test('multi-human group, last message NOT from owner → needs confirmation', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 3, owner: 7, driver: 9 }))
    expect(r).toEqual({ ok: false, reason: 'needs-confirmation' })
  })

  test('multi-human group, no recent driver → needs confirmation', async () => {
    const r = await isControlCommandAuthorized(42, deps({ humans: 3, owner: 7, driver: null }))
    expect(r).toEqual({ ok: false, reason: 'needs-confirmation' })
  })
})
