import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as agents from '../agents'
import * as bindings from '../bindings'
import * as audit from '../audit'
import { tryAutoApprove } from '../dispatcher/skip-permissions'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-skip-'))
  agents.setAgentsDir(join(root, 'agents'))
  bindings.setBindingsDir(join(root, 'bindings'))
  audit.setAuditDir(join(root, 'audit'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function saveTrustedAgent(id: string): void {
  const def: agents.AgentDef = {
    id,
    name: `${id} agent`,
    model: 'claude-sonnet-4-6',
    description: '',
    system: '',
    tools: [],
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

describe('tryAutoApprove', () => {
  test('returns allow verdict and writes audit entry for a trusted agent', () => {
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

    const auditPath = audit.auditFilePath(42)
    expect(existsSync(auditPath)).toBe(true)
    const body = readFileSync(auditPath, 'utf-8')
    expect(body).toContain('2026-04-10T12:00:00.000Z')
    expect(body).toContain('Bash')
    expect(body).toContain('ls -la')
    expect(body).toContain('trusted')
  })

  test('returns null for a chat bound to a non-skip agent', () => {
    const def: agents.AgentDef = {
      id: 'careful',
      name: 'Careful',
      model: 'claude-sonnet-4-6',
      description: '',
      system: '',
      tools: [],
    }
    agents.saveAgent(def)
    bindChat(7, 'careful')

    const verdict = tryAutoApprove(
      7,
      { id: 'req-2', tool: 'Edit', input: { file_path: '/tmp/foo' } },
    )
    expect(verdict).toBeNull()
    expect(existsSync(audit.auditFilePath(7))).toBe(false)
  })

  test('returns null for a chat with no binding', () => {
    const verdict = tryAutoApprove(
      99,
      { id: 'req-3', tool: 'Bash', input: { command: 'id' } },
    )
    expect(verdict).toBeNull()
    expect(existsSync(audit.auditFilePath(99))).toBe(false)
  })

  test('returns null when binding points at a missing agent', () => {
    bindChat(13, 'ghost')
    const verdict = tryAutoApprove(13, { id: 'req-4', tool: 'Bash', input: {} })
    expect(verdict).toBeNull()
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
    const body = readFileSync(audit.auditFilePath(42), 'utf-8')
    expect(body).toContain('unknown')
  })
})
