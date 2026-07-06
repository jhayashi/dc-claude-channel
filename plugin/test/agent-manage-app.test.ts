import { test, expect, beforeEach, mock } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentManageApp } from '../apps/agent-manage-app.js'
import * as agents from '../agents.js'
import * as bindings from '../bindings.js'
import * as access from '../access/index.js'
import type { AppContext } from '../webxdc-app.js'

test('exposes dc_open_agent_manage_card with required chat_id', () => {
  const t = agentManageApp.tools().find(x => x.name === 'dc_open_agent_manage_card')
  expect(t).toBeTruthy()
  expect(t!.inputSchema.required).toContain('chat_id')
})

test('dc_open_agent_manage_card refuses missing chat_id', async () => {
  const res = await agentManageApp.callTool('dc_open_agent_manage_card', {}, {} as any)
  expect(res?.isError).toBe(true)
})

// ── dc_rebind_chat ───────────────────────────────────────────────────────
//
// A direct, subagent-callable tool for "switch this chat to <named agent>"
// — the NL-message-driven counterpart to the card's webXDC rebind-chat
// action. Deliberately has NO auth/§6 callback: unlike a webXDC tap
// (unauthenticated senderAddr), this tool is only reachable via a real
// chat message, which the dispatcher's capability gate (requiresCapability:
// 'infrastructure', evaluated against the ACTUAL message sender's fromId —
// see access/gate.ts's applyCapabilityGate + server.ts's _currentDriver)
// already authorizes centrally before callTool ever runs. §6's "always
// refuse in multi-human groups" rule exists only to compensate for an
// unauthenticated tap; it doesn't apply to an authenticated message.

const agentsDir = mkdtempSync(join(tmpdir(), 'dc-rebind-tool-agents-'))
const bindingsDir = mkdtempSync(join(tmpdir(), 'dc-rebind-tool-bindings-'))
const accessDir = mkdtempSync(join(tmpdir(), 'dc-rebind-tool-access-'))

beforeEach(() => {
  agents.setAgentsDir(agentsDir)
  bindings.setBindingsDir(bindingsDir)
  access.setApprovedDir(accessDir)
  for (const dir of [agentsDir, bindingsDir, accessDir]) {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        try { rmSync(join(dir, f), { recursive: true, force: true }) } catch { /* ignore */ }
      }
    }
  }
})

function seedAgent(name: string): agents.AgentDef {
  const def: agents.AgentDef = {
    name, 'x-dc-display-name': name, model: 'claude-sonnet-4-6', description: '', body: 'x', tools: 'mcp__dc',
  }
  agents.saveAgent(def)
  return def
}

function makeStubCtx(): { ctx: AppContext; evict: ReturnType<typeof mock> } {
  const send = mock(async () => 1)
  const setChatProfileImage = mock(async () => {})
  const evict = mock(async () => {})
  const client = { send, setChatProfileImage } as unknown as AppContext['client']
  const ctx: AppContext = {
    client,
    mcp: {} as unknown as AppContext['mcp'],
    isAllowed: (chatId: number) => access.isAllowed(chatId),
    allowedChats: () => access.allowedChats(),
    logf: () => {},
    safeName: (s: string) => s,
    registerWebXDCMsg: () => {},
    unregisterWebXDCMsg: () => {},
    evictSubagent: evict,
    getAvailableMcpServers: () => [],
    getConnectedMcpServers: () => [],
    scheduleStore: {} as unknown as AppContext['scheduleStore'],
    subagentCache: { evictChat: async () => {} },
    cleanupChatState: async () => {},
  }
  return { ctx, evict }
}

test('dc_rebind_chat is capability-gated (infrastructure) with no auth param — the message-sender gate does the work', () => {
  const t = agentManageApp.tools().find(x => x.name === 'dc_rebind_chat')
  expect(t).toBeTruthy()
  expect(t!.requiresCapability).toBe('infrastructure')
  expect(t!.inputSchema.required).toEqual(expect.arrayContaining(['chat_id', 'agent_id']))
})

test('dc_rebind_chat refuses missing chat_id', async () => {
  const res = await agentManageApp.callTool('dc_rebind_chat', { agent_id: 'x' }, {} as any)
  expect(res?.isError).toBe(true)
})

test('dc_rebind_chat refuses missing agent_id', async () => {
  const res = await agentManageApp.callTool('dc_rebind_chat', { chat_id: '10' }, {} as any)
  expect(res?.isError).toBe(true)
})

test('dc_rebind_chat refuses an unknown agent_id', async () => {
  const { ctx } = makeStubCtx()
  const res = await agentManageApp.callTool('dc_rebind_chat', { chat_id: '10', agent_id: 'nonexistent' }, ctx)
  expect(res?.isError).toBe(true)
  expect(res?.content[0]?.text).toMatch(/not found|no longer exists/i)
})

test('dc_rebind_chat surfaces the "already on that agent" guard as isError, not a throw', async () => {
  const agent = seedAgent('dc-developer')
  bindings.bindAgent(20, agent.name, { inheritClaudeMd: false })
  const { ctx } = makeStubCtx()
  const res = await agentManageApp.callTool('dc_rebind_chat', { chat_id: '20', agent_id: 'dc-developer' }, ctx)
  expect(res?.isError).toBe(true)
  expect(res?.content[0]?.text).toMatch(/already on that agent/i)
})

test('dc_rebind_chat rebinds and clears the session by default', async () => {
  seedAgent('old-agent')
  const newAgent = seedAgent('new-agent')
  bindings.bindAgent(21, 'old-agent', { inheritClaudeMd: false })
  bindings.saveBinding({ ...bindings.getBinding(21)!, sessionId: 'sess-OLD' })
  const { ctx, evict } = makeStubCtx()

  const res = await agentManageApp.callTool('dc_rebind_chat', { chat_id: '21', agent_id: 'new-agent' }, ctx)
  expect(res?.isError).toBeFalsy()

  const after = bindings.getBinding(21)!
  expect(after.agentId).toBe(newAgent.name)
  expect(after.sessionId).toBeUndefined()
  expect(evict).toHaveBeenCalledWith(21)
})

test('dc_rebind_chat with keep_context:true preserves the session', async () => {
  seedAgent('old-agent-2')
  seedAgent('new-agent-2')
  bindings.bindAgent(22, 'old-agent-2', { inheritClaudeMd: false })
  bindings.saveBinding({ ...bindings.getBinding(22)!, sessionId: 'sess-KEEP' })
  const { ctx } = makeStubCtx()

  const res = await agentManageApp.callTool(
    'dc_rebind_chat', { chat_id: '22', agent_id: 'new-agent-2', keep_context: true }, ctx,
  )
  expect(res?.isError).toBeFalsy()
  expect(bindings.getBinding(22)!.sessionId).toBe('sess-KEEP')
})
