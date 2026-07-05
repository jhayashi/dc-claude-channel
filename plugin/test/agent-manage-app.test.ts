import { test, expect } from 'bun:test'
import { agentManageApp } from '../apps/agent-manage-app.js'

test('exposes dc_open_agent_manage_card with required chat_id', () => {
  const t = agentManageApp.tools().find(x => x.name === 'dc_open_agent_manage_card')
  expect(t).toBeTruthy()
  expect(t!.inputSchema.required).toContain('chat_id')
})

test('dc_open_agent_manage_card refuses missing chat_id', async () => {
  const res = await agentManageApp.callTool('dc_open_agent_manage_card', {}, {} as any)
  expect(res?.isError).toBe(true)
})
