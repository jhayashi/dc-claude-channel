import { test, expect } from 'bun:test'
import { handleDeleteAgent, handleSaveEdit } from '../apps/agent-setup-app.js'

// §6 gate: a delete refused by auth (e.g. multi-human group, where a webXDC
// tap can't be authenticated) must emit a generic `action_err` and mutate
// nothing. Decision #1 (increment 4): every state-changing manage handler
// shares ONE `action_err` refusal type so the Task-3 card needs a single
// refusal handler. The gate sits ABOVE the agent-existence check so the
// refusal is independent of whether the named agent happens to exist.
test('handleDeleteAgent refused by §6 → emits action_err, no delete', async () => {
  const sent: any[] = []
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) } },
    logf: () => {},
  }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleDeleteAgent(ctx, 99, 42, 'sleep-coach', auth)
  expect(sent.some(p => p.type === 'action_err')).toBe(true)
  expect(sent.some(p => p.type === 'deleted')).toBe(false)
})

test('handleSaveEdit refused by §6 → emits action_err, no editComplete', async () => {
  const sent: any[] = []
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) } },
    logf: () => {},
  }
  const auth = async () => ({ ok: false, reason: 'needs-confirmation' as const })
  await handleSaveEdit(ctx, 99, 42, { type: 'saveEdit', config: { model: 'claude-sonnet-4-6', name: 'x' }, agentId: 'x' }, auth)
  expect(sent.some(p => p.type === 'action_err')).toBe(true)
  expect(sent.some(p => p.type === 'editComplete')).toBe(false)
})

// #135: the undeletable built-in and the agent-gone case previously
// returned silently — the card hung in pendingAction:'delete' until a
// misattributed 10s "No response" timeout. Both must emit action_err.
test('handleDeleteAgent on the built-in default → emits action_err (#135)', async () => {
  const sent: any[] = []
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) } },
    logf: () => {},
  }
  const auth = async () => ({ ok: true as const })
  await handleDeleteAgent(ctx, 99, 42, 'claude-code', auth)
  const err = sent.find(p => p.type === 'action_err')
  expect(err).toBeTruthy()
  expect(err.message).toContain('default agent')
  expect(sent.some(p => p.type === 'deleted')).toBe(false)
})

test('handleDeleteAgent on a nonexistent agent → emits action_err (#135)', async () => {
  const sent: any[] = []
  const ctx: any = {
    client: { sendWebXDCUpdate: async (_m: number, u: string) => { sent.push(JSON.parse(u).payload) } },
    logf: () => {},
  }
  const auth = async () => ({ ok: true as const })
  await handleDeleteAgent(ctx, 99, 42, 'ghost-agent-135', auth)
  const err = sent.find(p => p.type === 'action_err')
  expect(err).toBeTruthy()
  expect(err.message).toContain('no longer exists')
})
