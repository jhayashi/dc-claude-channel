import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as audit from '../audit'

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'dc-audit-test-'))
  audit.setAuditDir(testDir)
})

beforeEach(() => {
  rmSync(testDir, { recursive: true, force: true })
  mkdirSync(testDir, { recursive: true })
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('audit log', () => {
  test('appendEntry creates the audit file on first call', () => {
    audit.appendEntry({
      chatId: 42,
      agentId: 'marketing-agent',
      tool: 'Bash',
      input: { command: 'ls -la' },
      timestamp: '2026-04-10T12:00:00.000Z',
    })
    const path = audit.auditFilePath(42)
    expect(existsSync(path)).toBe(true)
    const body = readFileSync(path, 'utf-8')
    expect(body).toContain('2026-04-10T12:00:00.000Z')
    expect(body).toContain('Bash')
    expect(body).toContain('ls -la')
    expect(body).toContain('marketing-agent')
  })

  test('appendEntry is append-only across calls', () => {
    audit.appendEntry({
      chatId: 42,
      agentId: 'a',
      tool: 'Bash',
      input: { command: 'echo one' },
      timestamp: '2026-04-10T12:00:00.000Z',
    })
    audit.appendEntry({
      chatId: 42,
      agentId: 'a',
      tool: 'Bash',
      input: { command: 'echo two' },
      timestamp: '2026-04-10T12:00:01.000Z',
    })
    const body = readFileSync(audit.auditFilePath(42), 'utf-8')
    expect(body).toContain('echo one')
    expect(body).toContain('echo two')
    expect(body.indexOf('echo one')).toBeLessThan(body.indexOf('echo two'))
  })

  test('per-chat isolation', () => {
    audit.appendEntry({
      chatId: 1,
      agentId: 'a',
      tool: 'Read',
      input: { file_path: '/tmp/a' },
      timestamp: '2026-04-10T12:00:00.000Z',
    })
    audit.appendEntry({
      chatId: 2,
      agentId: 'b',
      tool: 'Read',
      input: { file_path: '/tmp/b' },
      timestamp: '2026-04-10T12:00:01.000Z',
    })
    const bodyA = readFileSync(audit.auditFilePath(1), 'utf-8')
    const bodyB = readFileSync(audit.auditFilePath(2), 'utf-8')
    expect(bodyA).toContain('/tmp/a')
    expect(bodyA).not.toContain('/tmp/b')
    expect(bodyB).toContain('/tmp/b')
    expect(bodyB).not.toContain('/tmp/a')
  })

  test('long input values are truncated in the rendered output', () => {
    const longCmd = 'x'.repeat(5000)
    audit.appendEntry({
      chatId: 42,
      agentId: 'a',
      tool: 'Bash',
      input: { command: longCmd },
      timestamp: '2026-04-10T12:00:00.000Z',
    })
    const body = readFileSync(audit.auditFilePath(42), 'utf-8')
    expect(body).toContain('…')
    expect(body.length).toBeLessThan(5000)
  })

  test('auditFilePathIfExists returns null for a chat with no audit file', () => {
    expect(audit.auditFilePathIfExists(999)).toBeNull()
  })

  test('auditFilePathIfExists returns the path after first append', () => {
    audit.appendEntry({
      chatId: 7,
      agentId: 'a',
      tool: 'Bash',
      input: {},
      timestamp: '2026-04-10T12:00:00.000Z',
    })
    expect(audit.auditFilePathIfExists(7)).toBe(audit.auditFilePath(7))
  })
})
