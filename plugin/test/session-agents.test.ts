import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as sessionAgents from '../session-agents.js'

describe('session-agents index', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'session-agents-test-'))
    sessionAgents.setIndexDir(tmpDir)
  })

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it('returns null for unknown sessionId', () => {
    expect(sessionAgents.getAgentForSession('nonexistent')).toBeNull()
  })

  it('stores and retrieves a sessionId → agentId mapping', () => {
    sessionAgents.setAgentForSession('sess-1', 'marketing-agent')
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('marketing-agent')
  })

  it('overwrites an existing mapping', () => {
    sessionAgents.setAgentForSession('sess-1', 'old-agent')
    sessionAgents.setAgentForSession('sess-1', 'new-agent')
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('new-agent')
  })

  it('supports multiple independent mappings', () => {
    sessionAgents.setAgentForSession('sess-1', 'agent-a')
    sessionAgents.setAgentForSession('sess-2', 'agent-b')
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('agent-a')
    expect(sessionAgents.getAgentForSession('sess-2')).toBe('agent-b')
  })

  it('persists across reload (re-read from disk)', () => {
    sessionAgents.setAgentForSession('sess-1', 'agent-a')
    sessionAgents.setIndexDir(tmpDir)
    expect(sessionAgents.getAgentForSession('sess-1')).toBe('agent-a')
  })

  it('removeSession deletes a mapping', () => {
    sessionAgents.setAgentForSession('sess-1', 'agent-a')
    sessionAgents.removeSession('sess-1')
    expect(sessionAgents.getAgentForSession('sess-1')).toBeNull()
  })

  it('removeSession is a no-op for unknown sessions', () => {
    expect(() => sessionAgents.removeSession('nonexistent')).not.toThrow()
  })
})
