import { test, expect } from 'bun:test'
import { shouldOfferPermissions } from '../dispatcher/member-added-offer.js'

test('offers when an unpermissioned human joins an agent chat', () => {
  expect(shouldOfferPermissions({ isAgentChat: true, newMemberPermissioned: false, newMemberIsBotSelf: false }).offer).toBe(true)
})
test('does not offer for an already-permissioned member', () => {
  expect(shouldOfferPermissions({ isAgentChat: true, newMemberPermissioned: true, newMemberIsBotSelf: false }).offer).toBe(false)
})
test('does not offer when the bot itself is added', () => {
  expect(shouldOfferPermissions({ isAgentChat: true, newMemberPermissioned: false, newMemberIsBotSelf: true }).offer).toBe(false)
})
test('does not offer in a non-agent chat', () => {
  expect(shouldOfferPermissions({ isAgentChat: false, newMemberPermissioned: false, newMemberIsBotSelf: false }).offer).toBe(false)
})
