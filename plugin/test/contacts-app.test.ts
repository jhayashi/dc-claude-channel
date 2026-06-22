import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contactsApp } from '../apps/contacts-app.js'

test('exposes dc_open_contacts_card with required chat_id', () => {
  const t = contactsApp.tools().find(x => x.name === 'dc_open_contacts_card')
  expect(t).toBeTruthy()
  expect(t!.inputSchema.required).toContain('chat_id')
})

test('dc_open_contacts_card refuses missing chat_id', async () => {
  const res = await contactsApp.callTool('dc_open_contacts_card', {}, {} as any)
  expect(res?.isError).toBe(true)
})

// Structural guard: contacts-app.ts owns the list_contacts / assign_role
// dispatch wiring now that the monolith no longer handles them (peeled in
// increment 2 task 5). These tests ensure the routes don't get stripped
// accidentally during future cleanups — the same class of bug that hit
// agent-setup.ts in commit 9035b34.
test('list_contacts payload is dispatched in contacts-app (structural guard)', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', 'apps', 'contacts-app.ts'),
    'utf-8',
  )
  expect(src).toMatch(/payload\.type === 'list_contacts'/)
  expect(src).toMatch(/handleListContacts\(ctx,\s*msgId,\s*chatId\)/)
})

test('assign_role payload is dispatched in contacts-app (structural guard)', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', 'apps', 'contacts-app.ts'),
    'utf-8',
  )
  expect(src).toMatch(/payload\.type === 'assign_role'/)
  expect(src).toMatch(/handleAssignRole\(ctx,\s*msgId,\s*chatId/)
})
