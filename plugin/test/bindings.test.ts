import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as agents from '../agents'
import * as bindings from '../bindings'
import * as sessionAgents from '../session-agents'
import * as access from '../access/index.js'

const agentsDir = mkdtempSync(join(tmpdir(), 'dc-bindings-agents-'))
const bindingsDir = mkdtempSync(join(tmpdir(), 'dc-bindings-test-'))
const approvedDir = mkdtempSync(join(tmpdir(), 'dc-bindings-approved-'))

beforeAll(() => {
  agents.setAgentsDir(agentsDir)
  bindings.setBindingsDir(bindingsDir)
  sessionAgents.setIndexDir(bindingsDir)
  // Bindings.countByAgentId / sweepOrphans both filter via
  // access.isAllowed; without this they'd read the user's real
  // ~/.claude tree.
  access.setApprovedDir(approvedDir)
})

beforeEach(() => {
  // Clean all three dirs so tests start from a known state.
  // v1.3 slice 7: agents are subdirectories now, not flat YAMLs.
  for (const d of [agentsDir, bindingsDir, approvedDir]) {
    if (existsSync(d)) {
      for (const f of readdirSync(d)) {
        rmSync(join(d, f), { recursive: true, force: true })
      }
    }
  }
  // v1.3 slice 2: chat-allowlist is now in-memory. setApprovedDir
  // clears the cache too — call it between tests so state from a
  // prior test doesn't leak.
  access.setApprovedDir(approvedDir)
})

afterAll(() => {
  rmSync(agentsDir, { recursive: true, force: true })
  rmSync(bindingsDir, { recursive: true, force: true })
  rmSync(approvedDir, { recursive: true, force: true })
})

function makeAgent(id: string, overrides: Partial<agents.AgentDef> = {}): agents.AgentDef {
  return {
    id,
    name: `Test ${id}`,
    model: 'claude-sonnet-4-6',
    description: '',
    system: 'system prompt',
    tools: [],
    ...overrides,
  }
}

describe('bindings registry', () => {
  test('round-trips a full binding', () => {
    const b: bindings.Binding = {
      chatId: 42,
      agentId: 'marketing',
      sessionId: 'sess-uuid',
      inheritClaudeMd: false,
      createdAt: '2026-04-09T12:00:00.000Z',
    }
    bindings.saveBinding(b)
    expect(bindings.getBinding(42)).toEqual(b)
  })

  test('round-trips a minimal binding (no agent)', () => {
    const b: bindings.Binding = {
      chatId: 50,
      createdAt: '2026-04-09T12:00:00.000Z',
    }
    bindings.saveBinding(b)
    expect(bindings.getBinding(50)).toEqual(b)
  })

  test('getBinding returns null for missing chat', () => {
    expect(bindings.getBinding(999999)).toBeNull()
  })

  test('getBinding returns null for corrupt JSON', () => {
    writeFileSync(join(bindingsDir, '77.json'), '{not json')
    expect(bindings.getBinding(77)).toBeNull()
  })

  test('rejects invalid schema on save', () => {
    expect(() =>
      bindings.saveBinding({ chatId: 'not-a-number' } as unknown as bindings.Binding),
    ).toThrow()
  })

  test('listBindings returns all bindings sorted by chatId', () => {
    bindings.saveBinding({ chatId: 3, createdAt: 'now' })
    bindings.saveBinding({ chatId: 1, createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, createdAt: 'now' })
    expect(bindings.listBindings().map(b => b.chatId)).toEqual([1, 2, 3])
  })

  test('listBindings empty when directory missing', () => {
    rmSync(bindingsDir, { recursive: true, force: true })
    expect(bindings.listBindings()).toEqual([])
  })

  test('deleteBinding removes the file', () => {
    bindings.saveBinding({ chatId: 42, createdAt: 'now' })
    expect(bindings.deleteBinding(42)).toBe(true)
    expect(bindings.getBinding(42)).toBeNull()
    expect(bindings.deleteBinding(42)).toBe(false)
  })
})

describe('resolveChat', () => {
  test('returns null when no binding exists', () => {
    expect(bindings.resolveChat(42)).toBeNull()
  })

  test('returns null when binding has no agentId', () => {
    bindings.saveBinding({ chatId: 42, sessionId: 'sess', createdAt: 'now' })
    expect(bindings.resolveChat(42)).toBeNull()
  })

  test('returns null when referenced agent is missing', () => {
    bindings.saveBinding({ chatId: 42, agentId: 'ghost', createdAt: 'now' })
    expect(bindings.resolveChat(42)).toBeNull()
  })

  test('joins binding and agent when both exist', () => {
    const agent = makeAgent('marketing', { name: 'Marketing Agent' })
    agents.saveAgent(agent)
    bindings.saveBinding({
      chatId: 42,
      agentId: 'marketing',
      sessionId: 'sess',
      inheritClaudeMd: false,
      createdAt: 'now',
    })
    const resolved = bindings.resolveChat(42)
    expect(resolved).not.toBeNull()
    expect(resolved!.agent).toEqual(agent)
    expect(resolved!.binding.chatId).toBe(42)
  })
})

describe('session id lifecycle', () => {
  test('loadOrCreateSessionId creates a fresh uuid on first call', () => {
    const { sessionId, created } = bindings.loadOrCreateSessionId(42)
    expect(created).toBe(true)
    expect(sessionId.length).toBeGreaterThan(0)
    // Binding should now exist with that sessionId and no agentId.
    const b = bindings.getBinding(42)
    expect(b?.sessionId).toBe(sessionId)
    expect(b?.agentId).toBeUndefined()
  })

  test('loadOrCreateSessionId reuses the existing session on second call', () => {
    const first = bindings.loadOrCreateSessionId(42)
    const second = bindings.loadOrCreateSessionId(42)
    expect(second.created).toBe(false)
    expect(second.sessionId).toBe(first.sessionId)
  })

  test('loadOrCreateSessionId gives different ids to different chats', () => {
    const a = bindings.loadOrCreateSessionId(1).sessionId
    const b = bindings.loadOrCreateSessionId(2).sessionId
    expect(a).not.toBe(b)
  })

  test('loadOrCreateSessionId preserves an existing agentId on the binding', () => {
    bindings.saveBinding({
      chatId: 42,
      agentId: 'marketing',
      inheritClaudeMd: false,
      createdAt: '2026-04-09T12:00:00.000Z',
    })
    const { sessionId, created } = bindings.loadOrCreateSessionId(42)
    expect(created).toBe(true)
    const b = bindings.getBinding(42)
    expect(b?.agentId).toBe('marketing')
    expect(b?.sessionId).toBe(sessionId)
    expect(b?.inheritClaudeMd).toBe(false)
    expect(b?.createdAt).toBe('2026-04-09T12:00:00.000Z')
  })

  test('clearSessionId drops the uuid but keeps the binding', () => {
    bindings.saveBinding({
      chatId: 42,
      agentId: 'marketing',
      sessionId: 'old-sess',
      inheritClaudeMd: false,
      createdAt: '2026-04-09T12:00:00.000Z',
    })
    bindings.clearSessionId(42)
    const b = bindings.getBinding(42)
    expect(b).not.toBeNull()
    expect(b?.sessionId).toBeUndefined()
    expect(b?.agentId).toBe('marketing')
  })

  test('clearSessionId is a no-op when no binding exists', () => {
    expect(() => bindings.clearSessionId(999)).not.toThrow()
    expect(bindings.getBinding(999)).toBeNull()
  })

  test('clearSessionId then loadOrCreateSessionId produces a fresh uuid', () => {
    const first = bindings.loadOrCreateSessionId(42)
    bindings.clearSessionId(42)
    const second = bindings.loadOrCreateSessionId(42)
    expect(second.created).toBe(true)
    expect(second.sessionId).not.toBe(first.sessionId)
  })

  test('session survives a simulated process restart', () => {
    const first = bindings.loadOrCreateSessionId(42)
    // Simulate restart: reset to the same dir, reload.
    bindings.setBindingsDir(bindingsDir)
    const second = bindings.loadOrCreateSessionId(42)
    expect(second.created).toBe(false)
    expect(second.sessionId).toBe(first.sessionId)
  })
})

describe('bindAgent', () => {
  test('creates a new binding on a fresh chat', () => {
    agents.saveAgent(makeAgent('coding'))
    const b = bindings.bindAgent(42, 'coding', { inheritClaudeMd: true })
    expect(b.chatId).toBe(42)
    expect(b.agentId).toBe('coding')
    expect(b.inheritClaudeMd).toBe(true)
    expect(b.sessionId).toBeUndefined()
    expect(b.createdAt).toBeTruthy()
    expect(bindings.getBinding(42)?.agentId).toBe('coding')
  })

  test('preserves sessionId when updating an existing binding', () => {
    // Simulate: session was created before agent was bound.
    bindings.loadOrCreateSessionId(42)
    const existingSession = bindings.getBinding(42)!.sessionId!
    expect(existingSession).toBeTruthy()

    agents.saveAgent(makeAgent('marketing'))
    const bound = bindings.bindAgent(42, 'marketing', { inheritClaudeMd: false })
    expect(bound.sessionId).toBe(existingSession)
    expect(bound.agentId).toBe('marketing')
  })

  test('preserves createdAt when updating an existing binding', () => {
    const originalCreatedAt = '2026-01-01T00:00:00.000Z'
    bindings.saveBinding({ chatId: 42, createdAt: originalCreatedAt })
    agents.saveAgent(makeAgent('m'))
    const b = bindings.bindAgent(42, 'm', { inheritClaudeMd: true })
    expect(b.createdAt).toBe(originalCreatedAt)
  })

  test('preserves workingDir when updating an existing binding', () => {
    // Real data-loss path: user attaches a terminal session (sets
    // workingDir), then picks an agent via the setup card. Without
    // preservation the subagent re-spawns in process.cwd() and the
    // session .jsonl at the attached cwd is unreachable.
    bindings.saveBinding({
      chatId: 42,
      sessionId: 'attached-sess-0000-0000-0000-000000000000',
      workingDir: '/home/user/src/terminal-project',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    agents.saveAgent(makeAgent('m'))
    const b = bindings.bindAgent(42, 'm', { inheritClaudeMd: true })
    expect(b.workingDir).toBe('/home/user/src/terminal-project')
  })

  test('saveBinding writes sessionId→agentId to session-agents index', () => {
    bindings.saveBinding({
      chatId: 10,
      agentId: 'marketing-agent',
      sessionId: 'sess-abc',
      createdAt: new Date().toISOString(),
    })
    expect(sessionAgents.getAgentForSession('sess-abc')).toBe('marketing-agent')
  })

  test('saveBinding skips index write when sessionId or agentId is missing', () => {
    bindings.saveBinding({
      chatId: 11,
      agentId: 'some-agent',
      createdAt: new Date().toISOString(),
    })
    bindings.saveBinding({
      chatId: 12,
      sessionId: 'sess-xyz',
      createdAt: new Date().toISOString(),
    })
    expect(sessionAgents.getAgentForSession('sess-xyz')).toBeNull()
  })

  test('bindAgent writes to session-agents index when sessionId exists', () => {
    bindings.saveBinding({
      chatId: 13,
      sessionId: 'sess-pre',
      createdAt: new Date().toISOString(),
    })
    agents.saveAgent(makeAgent('coach'))
    bindings.bindAgent(13, 'coach', { inheritClaudeMd: true })
    expect(sessionAgents.getAgentForSession('sess-pre')).toBe('coach')
  })
})

describe('bindAgent heals terminal-CC agents lacking mcp__dc', () => {
  test('re-saves the agent on bind so saveAgent auto-injects mcp__dc', () => {
    // Simulate a terminal-CC agent file with no mcp__dc in its tools.
    // Write directly via fs to bypass saveAgent's auto-injection.
    writeFileSync(
      join(agentsDir, 'cc-only.md'),
      '---\nname: cc-only\nmodel: claude-sonnet-4-6\ntools: Read, Bash\n---\nbody\n',
    )
    expect(agents.getAgent('cc-only')?.tools).not.toContain('mcp__dc')

    bindings.bindAgent(42, 'cc-only', { inheritClaudeMd: false })

    // Bind triggers a re-save through saveAgent, which auto-injects mcp__dc.
    expect(agents.getAgent('cc-only')?.tools).toContain('mcp__dc')
  })

  test('no-op when the agent already has mcp__dc', () => {
    // Use saveAgent so mcp__dc is already present; capture file mtime.
    writeFileSync(
      join(agentsDir, 'dc-native.md'),
      '---\nname: dc-native\nmodel: claude-sonnet-4-6\ntools: Read, mcp__dc\n---\nbody\n',
    )
    bindings.bindAgent(42, 'dc-native', { inheritClaudeMd: false })
    const tools = agents.getAgent('dc-native')!.tools
    // Should appear exactly once.
    const matches = tools.match(/mcp__dc/g) ?? []
    expect(matches.length).toBe(1)
  })

  test('silently skips when the bound agent name does not resolve', () => {
    // No file at agentsDir/ghost.md.
    expect(() => bindings.bindAgent(42, 'ghost', { inheritClaudeMd: false }))
      .not.toThrow()
  })
})

describe('countByAgentId', () => {
  test('returns 0 when no bindings exist', () => {
    expect(bindings.countByAgentId('marketing')).toBe(0)
  })

  test('counts only bindings with matching agentId', () => {
    access.addChat(1, 100)
    access.addChat(2, 100)
    access.addChat(3, 100)
    bindings.saveBinding({ chatId: 1, agentId: 'marketing', createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, agentId: 'sales', createdAt: 'now' })
    bindings.saveBinding({ chatId: 3, agentId: 'marketing', createdAt: 'now' })
    expect(bindings.countByAgentId('marketing')).toBe(2)
    expect(bindings.countByAgentId('sales')).toBe(1)
    expect(bindings.countByAgentId('ghost')).toBe(0)
  })

  test('excludes bindings whose chat is no longer approved (orphans)', () => {
    // chat 1 is approved + bound; chat 2 is bound but unapproved (orphan).
    access.addChat(1, 100)
    bindings.saveBinding({ chatId: 1, agentId: 'marketing', createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, agentId: 'marketing', createdAt: 'now' })
    expect(bindings.countByAgentId('marketing')).toBe(1)
  })

  test('excludes bindings without an agentId', () => {
    access.addChat(1, 100)
    access.addChat(2, 100)
    bindings.saveBinding({ chatId: 1, agentId: 'marketing', createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, createdAt: 'now' }) // unbound
    expect(bindings.countByAgentId('marketing')).toBe(1)
  })

  test('handles many bindings under one agent', () => {
    for (let i = 1; i <= 20; i++) {
      access.addChat(i, 100)
      bindings.saveBinding({ chatId: i, agentId: 'busy', createdAt: 'now' })
    }
    expect(bindings.countByAgentId('busy')).toBe(20)
  })
})

describe('sweepOrphans', () => {
  test('returns 0 when no bindings exist', () => {
    expect(bindings.sweepOrphans()).toBe(0)
  })

  test('returns 0 when every binding is approved', () => {
    access.addChat(1, 100)
    access.addChat(2, 100)
    bindings.saveBinding({ chatId: 1, agentId: 'a', createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, agentId: 'a', createdAt: 'now' })
    expect(bindings.sweepOrphans()).toBe(0)
    expect(bindings.listBindings()).toHaveLength(2)
  })

  test('removes bindings for unapproved chats and returns the count', () => {
    access.addChat(1, 100)
    bindings.saveBinding({ chatId: 1, agentId: 'a', createdAt: 'now' }) // kept
    bindings.saveBinding({ chatId: 2, agentId: 'a', createdAt: 'now' }) // orphan
    bindings.saveBinding({ chatId: 3, agentId: 'a', createdAt: 'now' }) // orphan
    expect(bindings.sweepOrphans()).toBe(2)
    expect(bindings.listBindings().map((b) => b.chatId)).toEqual([1])
  })

  test('removes bindings without agentId if their chat is unapproved', () => {
    access.addChat(1, 100)
    bindings.saveBinding({ chatId: 1, createdAt: 'now' }) // approved, no agent — kept
    bindings.saveBinding({ chatId: 2, createdAt: 'now' }) // unapproved, no agent — orphan
    expect(bindings.sweepOrphans()).toBe(1)
    expect(bindings.listBindings().map((b) => b.chatId)).toEqual([1])
  })

  test('is idempotent — second sweep finds nothing', () => {
    bindings.saveBinding({ chatId: 1, agentId: 'a', createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, agentId: 'a', createdAt: 'now' })
    expect(bindings.sweepOrphans()).toBe(2)
    expect(bindings.sweepOrphans()).toBe(0)
  })

  test('does not touch approved bindings even when other orphans are swept', () => {
    access.addChat(1, 100)
    access.addChat(3, 100)
    bindings.saveBinding({ chatId: 1, agentId: 'a', sessionId: 's1', createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, agentId: 'b', sessionId: 's2', createdAt: 'now' }) // orphan
    bindings.saveBinding({ chatId: 3, agentId: 'c', sessionId: 's3', createdAt: 'now' })
    expect(bindings.sweepOrphans()).toBe(1)
    const remaining = bindings.listBindings()
    expect(remaining.map((b) => b.chatId)).toEqual([1, 3])
    // Sessions on the kept bindings must survive untouched.
    expect(remaining.find((b) => b.chatId === 1)?.sessionId).toBe('s1')
    expect(remaining.find((b) => b.chatId === 3)?.sessionId).toBe('s3')
  })

  test('countByAgentId reflects the post-sweep state', () => {
    access.addChat(1, 100)
    bindings.saveBinding({ chatId: 1, agentId: 'a', createdAt: 'now' })
    bindings.saveBinding({ chatId: 2, agentId: 'a', createdAt: 'now' }) // orphan
    bindings.saveBinding({ chatId: 3, agentId: 'a', createdAt: 'now' }) // orphan
    // Pre-sweep, countByAgentId already filters orphans (1).
    expect(bindings.countByAgentId('a')).toBe(1)
    bindings.sweepOrphans()
    // Post-sweep, the count is the same — sweep + count agree.
    expect(bindings.countByAgentId('a')).toBe(1)
  })
})
