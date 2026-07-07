import { test, expect } from 'bun:test'
import { shouldOfferPermissions, shouldOfferAgentSetup, freshPermissionOfferTargets } from '../dispatcher/member-added-offer.js'

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

test('offers agent setup when the bot is added to an agentless chat', () => {
  expect(shouldOfferAgentSetup({ botWasAdded: true, chatHasAgent: false }).offer).toBe(true)
})
test('does not offer agent setup when an agent is already bound', () => {
  expect(shouldOfferAgentSetup({ botWasAdded: true, chatHasAgent: true }).offer).toBe(false)
})
test('does not offer agent setup when the bot was not the added member', () => {
  expect(shouldOfferAgentSetup({ botWasAdded: false, chatHasAgent: false }).offer).toBe(false)
})

// freshPermissionOfferTargets — dedup so a lingering unpermissioned member
// doesn't re-trigger (and re-name) an offer on every later member-add (#117).
test('returns all unpermissioned members when none were offered yet', () => {
  expect(freshPermissionOfferTargets([11, 12], () => false)).toEqual([11, 12])
})
test('drops members already offered this session', () => {
  const offered = new Set([11])
  expect(freshPermissionOfferTargets([11, 12], (id) => offered.has(id))).toEqual([12])
})
test('returns empty (no offer) when every unpermissioned member was already offered', () => {
  expect(freshPermissionOfferTargets([11, 12], () => true)).toEqual([])
})
