import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { handleUpdateAgentTool, type UpdateAgentToolDeps } from '../dispatcher/update-agent-tool.js'
import * as agents from '../agents.js'
import * as bindings from '../bindings.js'

// #135: dc_update_agent gains `name` (display rename) — the Appendix A
// "rename yourself to Atlas" execute lane. Extracted from the server.ts
// tailHandlers closure per the fix-carries-its-seam rule (#137).

const CALLER_CHAT = 30
const OTHER_CHAT = 31

function makeDeps() {
  const evicted: number[] = []
  const decorated: Array<{ chatId: number; agentName: string }> = []
  const deps: UpdateAgentToolDeps = {
    evictChat: async (chatId: number) => { evicted.push(chatId) },
    refreshChatDecoration: async (chatId: number, agentName: string) => {
      decorated.push({ chatId, agentName })
    },
    logf: () => {},
  }
  return { deps, evicted, decorated }
}

describe('dc_update_agent handler (#135)', () => {
  let agentsDir: string
  let bindingsDir: string

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'uat-agents-'))
    bindingsDir = mkdtempSync(join(tmpdir(), 'uat-bindings-'))
    agents.setAgentsDir(agentsDir)
    bindings.setBindingsDir(bindingsDir)
    agents.saveAgent({
      name: 'atlas-agent',
      description: 't',
      model: 'claude-sonnet-5',
      body: 'You help.',
    } as agents.AgentDef)
    bindings.saveBinding({ chatId: CALLER_CHAT, agentId: 'atlas-agent', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    bindings.saveBinding({ chatId: OTHER_CHAT, agentId: 'atlas-agent', inheritClaudeMd: false, createdAt: new Date().toISOString() })
  })

  afterEach(() => {
    for (const d of [agentsDir, bindingsDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  test('rename writes x-dc-display-name and refreshes decoration, no evict', async () => {
    const { deps, evicted, decorated } = makeDeps()
    const res = await handleUpdateAgentTool(deps, { chat_id: String(CALLER_CHAT), name: 'Atlas' }, CALLER_CHAT)
    expect(res.isError).toBeUndefined()
    expect(agents.getAgent('atlas-agent')!['x-dc-display-name']).toBe('Atlas')
    // slug is pinned — rename never moves the file
    expect(agents.getAgent('atlas-agent')).not.toBeNull()
    // display rename is cosmetic: no subagent restart
    expect(evicted).toEqual([])
    // both bound chats get badge + chat-name refresh
    expect(decorated.map(d => d.chatId).sort()).toEqual([CALLER_CHAT, OTHER_CHAT])
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('Atlas')
  })

  test('prompt update still evicts other chats but defers the caller', async () => {
    const { deps, evicted } = makeDeps()
    const res = await handleUpdateAgentTool(deps, { chat_id: String(CALLER_CHAT), prompt: 'Be terse.' }, CALLER_CHAT)
    expect(res.isError).toBeUndefined()
    // serializer guarantees a trailing newline on the body
    expect(agents.getAgent('atlas-agent')!.body.trim()).toBe('Be terse.')
    expect(evicted).toEqual([OTHER_CHAT])
  })

  test('rename combined with model change evicts (model forces respawn)', async () => {
    const { deps, evicted } = makeDeps()
    const res = await handleUpdateAgentTool(
      deps,
      { chat_id: String(CALLER_CHAT), name: 'Atlas', model: 'claude-haiku-4-5' },
      CALLER_CHAT,
    )
    expect(res.isError).toBeUndefined()
    expect(evicted).toEqual([OTHER_CHAT])
    expect(agents.getAgent('atlas-agent')!['x-dc-display-name']).toBe('Atlas')
  })

  test('requires at least one of prompt, model, name', async () => {
    const { deps } = makeDeps()
    const res = await handleUpdateAgentTool(deps, { chat_id: String(CALLER_CHAT) }, CALLER_CHAT)
    expect(res.isError).toBe(true)
    const text = (res.content[0] as { text: string }).text
    expect(text).toContain('name')
  })

  test('invalid model still rejected', async () => {
    const { deps } = makeDeps()
    const res = await handleUpdateAgentTool(deps, { chat_id: String(CALLER_CHAT), model: 'gpt-4' }, CALLER_CHAT)
    expect(res.isError).toBe(true)
  })

  test('unbound chat is an error', async () => {
    const { deps } = makeDeps()
    const res = await handleUpdateAgentTool(deps, { chat_id: '999', name: 'X' }, 999)
    expect(res.isError).toBe(true)
  })
})
