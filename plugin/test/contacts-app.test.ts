import { test, expect } from 'bun:test'
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
