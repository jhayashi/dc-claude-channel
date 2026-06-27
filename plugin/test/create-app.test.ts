import { test, expect } from 'bun:test'
import { createApp } from '../apps/create-app.js'

test('exposes dc_open_create_card with required chat_id + optional seedLeaf', () => {
  const t = createApp.tools().find(x => x.name === 'dc_open_create_card')
  expect(t).toBeTruthy()
  expect(t!.inputSchema.required).toContain('chat_id')
  expect(t!.inputSchema.properties).toHaveProperty('seedLeaf')
})

test('dc_open_create_card refuses missing chat_id', async () => {
  const res = await createApp.callTool('dc_open_create_card', {}, {} as any)
  expect(res?.isError).toBe(true)
})
