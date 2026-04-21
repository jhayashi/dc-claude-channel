import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as bindings from '../bindings'
import * as access from '../access/index.js'
import * as agents from '../agents'
import { buildTeleportOutList } from '../apps/agent-setup-app'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-teleport-out-'))
  bindings.setBindingsDir(join(tmp, 'bindings'))
  access.setApprovedDir(join(tmp, 'approved'))
  agents.setAgentsDir(join(tmp, 'agents'))
})
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

function stubCtx(overrides: Partial<{
  jobCountForChat: (n: number) => number
  sessionLive: (p: string) => boolean
  chatNameForId: (n: number) => string | null
}> = {}) {
  return {
    jobCountForChat: overrides.jobCountForChat ?? (() => 0),
    sessionLive: overrides.sessionLive ?? (() => false),
    chatNameForId: overrides.chatNameForId ?? ((n: number) => `Chat ${n}`),
  }
}

describe('buildTeleportOutList', () => {
  test('excludes chats not in the access list', () => {
    bindings.saveBinding({ chatId: 1, agentId: 'a', createdAt: '2026-04-01T00:00:00Z' })
    // chat 1 not in access list
    expect(buildTeleportOutList(stubCtx()).length).toBe(0)
  })

  test('includes paired chats with metadata', () => {
    agents.saveAgent({
      id: 'marketer', name: 'Marketer', model: 'claude-sonnet-4-6',
      description: '', system: '', tools: [],
    } as agents.AgentDef)
    bindings.saveBinding({
      chatId: 7, agentId: 'marketer', sessionId: 'sess-1',
      workingDir: '/tmp/proj', createdAt: '2026-04-01T00:00:00Z',
    })
    access.addChat(7, 99)
    const list = buildTeleportOutList(stubCtx({
      jobCountForChat: (n) => n === 7 ? 3 : 0,
      chatNameForId: () => 'Marketing thread',
    }))
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({
      chatId: 7,
      chatName: 'Marketing thread',
      agentId: 'marketer',
      agentName: 'Marketer',
      jobCount: 3,
      isTrusted: false,
      isLive: false,
    })
  })

  test('marks trusted agents', () => {
    const a: agents.AgentDef = {
      id: 'trusted', name: 'Trusted', model: 'claude-sonnet-4-6',
      description: '', system: '', tools: [],
      metadata: { 'x-dc-skipPermissions': true },
    } as agents.AgentDef
    agents.saveAgent(a)
    bindings.saveBinding({ chatId: 8, agentId: 'trusted', createdAt: '2026-04-01T00:00:00Z' })
    access.addChat(8, 99)
    const list = buildTeleportOutList(stubCtx())
    expect(list[0].isTrusted).toBe(true)
  })
})
