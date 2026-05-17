import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as agents from '../agents'
import * as bindings from '../bindings'
import { getEventDir, setEventDir } from '../events'
import { tryAutoApprove } from '../dispatcher/skip-permissions'

let root: string
let prevEventDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-skip-'))
  agents.setAgentsDir(join(root, 'agents'))
  bindings.setBindingsDir(join(root, 'bindings'))
  prevEventDir = getEventDir()
  setEventDir(join(root, 'events'))
})

afterEach(() => {
  setEventDir(prevEventDir)
  rmSync(root, { recursive: true, force: true })
})

function saveTrustedAgent(name: string): void {
  const def: agents.AgentDef = {
    name,
    description: '',
    model: 'claude-sonnet-4-6',
    tools: 'mcp__dc',
    body: '',
  }
  agents.setSkipPermissions(def, true)
  agents.saveAgent(def)
}

function bindChat(chatId: number, agentId: string): void {
  bindings.saveBinding({
    chatId,
    agentId,
    sessionId: '00000000-0000-0000-0000-000000000000',
    createdAt: '2026-04-10T00:00:00.000Z',
  })
}

/** Read and JSON.parse every line across every `permissions-*.log` file in the event dir. */
function readPermissionLog(): Record<string, unknown>[] {
  const eventsDir = join(root, 'events')
  if (!existsSync(eventsDir)) return []
  const files = readdirSync(eventsDir).filter((f) => f.startsWith('permissions-'))
  return files.flatMap((f) =>
    readFileSync(join(eventsDir, f), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  )
}

describe('tryAutoApprove', () => {
  test('returns allow verdict and writes skip_auto log entry for a trusted agent', () => {
    saveTrustedAgent('trusted')
    bindChat(42, 'trusted')

    const verdict = tryAutoApprove(
      42,
      { id: 'req-1', tool: 'Bash', input: { command: 'ls -la' } },
      () => '2026-04-10T12:00:00.000Z',
    )
    expect(verdict).not.toBeNull()
    expect(verdict!.kind).toBe('permissionVerdict')
    if (verdict!.kind === 'permissionVerdict') {
      expect(verdict!.id).toBe('req-1')
      expect(verdict!.verdict).toBe('allow')
    }

    const entries = readPermissionLog()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      ts: '2026-04-10T12:00:00.000Z',
      chatId: 42,
      agentId: 'trusted',
      tool: 'Bash',
      verdict: 'allow',
      reason: 'skip_auto',
      timedOut: false,
      durationMs: 0,
    })
    expect(entries[0].inputPreview).toContain('command=ls -la')
  })

  test('returns null and writes nothing for a chat bound to a non-skip agent', () => {
    const def: agents.AgentDef = {
      name: 'careful',
      description: '',
      model: 'claude-sonnet-4-6',
      tools: 'mcp__dc',
      body: '',
    }
    agents.saveAgent(def)
    bindChat(7, 'careful')

    const verdict = tryAutoApprove(
      7,
      { id: 'req-2', tool: 'Edit', input: { file_path: '/tmp/foo' } },
    )
    expect(verdict).toBeNull()
    expect(readPermissionLog()).toEqual([])
  })

  test('returns null and writes nothing for a chat with no binding', () => {
    const verdict = tryAutoApprove(
      99,
      { id: 'req-3', tool: 'Bash', input: { command: 'id' } },
    )
    expect(verdict).toBeNull()
    expect(readPermissionLog()).toEqual([])
  })

  test('returns null when binding points at a missing agent', () => {
    bindChat(13, 'ghost')
    const verdict = tryAutoApprove(13, { id: 'req-4', tool: 'Bash', input: {} })
    expect(verdict).toBeNull()
    expect(readPermissionLog()).toEqual([])
  })

  test('handles missing tool name and input gracefully', () => {
    saveTrustedAgent('trusted')
    bindChat(42, 'trusted')
    const verdict = tryAutoApprove(
      42,
      { id: 'req-5' },
      () => '2026-04-10T12:00:00.000Z',
    )
    expect(verdict).not.toBeNull()
    const entries = readPermissionLog()
    expect(entries).toHaveLength(1)
    expect(entries[0].tool).toBe('unknown')
    expect(entries[0].inputPreview).toBe('')
  })

  test('redacts sensitive keys in inputPreview', () => {
    saveTrustedAgent('trusted')
    bindChat(42, 'trusted')
    tryAutoApprove(
      42,
      { id: 'req-6', tool: 'Bash', input: { command: 'curl', token: 'sk-abc123secret' } },
      () => '2026-04-10T12:00:00.000Z',
    )
    const entries = readPermissionLog()
    expect(entries).toHaveLength(1)
    expect(entries[0].inputPreview).toContain('token=<redacted>')
    expect(entries[0].inputPreview).not.toContain('sk-abc123secret')
  })
})
