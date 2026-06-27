import { test, expect } from 'bun:test'
import { createApp } from '../apps/create-app.js'
import { handleCreateAgent } from '../apps/agent-setup-app.js'

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

// §6 gate: a create refused by auth (e.g. multi-human group, where a
// webXDC tap can't be authenticated) must emit `create_err` and write
// nothing. The card's `create_err` handler (create-agent.html) depends on
// this exact reply type — a mismatch would surface a misleading 15s
// "no response" timeout instead of the needs-confirmation guidance.
test('handleCreateAgent refused by §6 auth → emits create_err, never created', async () => {
  const sent: any[] = []
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) } },
    logf: () => {},
  }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  // Valid draft config so the parse passes and we reach the auth gate.
  await handleCreateAgent(ctx, 99, 42, { type: 'create', config: { model: 'claude-sonnet-4-6', name: 'Test Agent' } }, auth)
  expect(sent.some(p => p.type === 'create_err')).toBe(true)
  expect(sent.some(p => p.type === 'created')).toBe(false)
  // The refusal message is the needs-confirmation guidance, not a generic error.
  const err = sent.find(p => p.type === 'create_err')
  expect(typeof err.message).toBe('string')
  expect(err.message.length).toBeGreaterThan(0)
})
