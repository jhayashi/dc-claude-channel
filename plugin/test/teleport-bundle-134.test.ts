import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as resume from '../resume.js'
import * as bindings from '../bindings.js'
import * as agents from '../agents.js'
import * as sessionAgents from '../session-agents.js'
import { resolveAttachAgent } from '../apps/agent-setup-app.js'

// #134 regression suite: pruned-workingDir resume commands and
// stale-session-index ghost-agent bindings.

describe('buildResumeCommand with pruned workingDir (#134)', () => {
  let bindingsDir: string
  let projectsRoot: string
  let liveDir: string

  beforeEach(() => {
    bindingsDir = mkdtempSync(join(tmpdir(), 'tb-bindings-'))
    projectsRoot = mkdtempSync(join(tmpdir(), 'tb-projects-'))
    liveDir = mkdtempSync(join(tmpdir(), 'tb-live-'))
    bindings.setBindingsDir(bindingsDir)
    resume.setProjectsRoot(projectsRoot)
  })

  afterEach(() => {
    for (const d of [bindingsDir, projectsRoot, liveDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  test('gone workingDir → error, not a dead cd command', () => {
    // The old behavior completed the whole teleport (chat torn down!) and
    // handed the user `cd <missing> && claude --resume ...`.
    bindings.saveBinding({
      chatId: 5,
      agentId: 'claude-code',
      inheritClaudeMd: false,
      workingDir: '/tmp/definitely-gone-worktree-134',
      sessionId: '00000000-0000-0000-0000-000000000134',
      createdAt: new Date().toISOString(),
    })
    const res = resume.buildResumeCommand(5)
    expect('error' in res).toBe(true)
    if ('error' in res) {
      expect(res.error).toContain('/tmp/definitely-gone-worktree-134')
      expect(res.error.toLowerCase()).toContain('no longer exists')
    }
  })

  test('live workingDir still produces the command', () => {
    bindings.saveBinding({
      chatId: 6,
      agentId: 'claude-code',
      inheritClaudeMd: false,
      workingDir: liveDir,
      createdAt: new Date().toISOString(),
    })
    const res = resume.buildResumeCommand(6)
    expect('error' in res).toBe(false)
    if (!('error' in res)) {
      expect(res.command).toContain(`cd ${liveDir}`)
    }
  })

  test('missing workingDir falls back (unchanged behavior)', () => {
    bindings.saveBinding({
      chatId: 7,
      agentId: 'claude-code',
      inheritClaudeMd: false,
      createdAt: new Date().toISOString(),
    })
    const res = resume.buildResumeCommand(7)
    expect('error' in res).toBe(false)
  })
})

describe('resolveAttachAgent ghost-agent fallback (#134)', () => {
  let agentsDir: string
  let bindingsDir: string
  let indexDir: string

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'tb-agents-'))
    bindingsDir = mkdtempSync(join(tmpdir(), 'tb-bind2-'))
    indexDir = mkdtempSync(join(tmpdir(), 'tb-index-'))
    agents.setAgentsDir(agentsDir)
    bindings.setBindingsDir(bindingsDir)
    sessionAgents.setIndexDir(indexDir)
  })

  afterEach(() => {
    for (const d of [agentsDir, bindingsDir, indexDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  function seedAgent(name: string): void {
    agents.saveAgent({
      name,
      description: 't',
      model: 'claude-sonnet-5',
      body: 'x',
    } as agents.AgentDef)
  }

  test('stale index entry (deleted agent) falls back to the source chat agent', () => {
    const SESSION = '11111111-1111-1111-1111-000000000134'
    seedAgent('alive-agent')
    bindings.saveBinding({ chatId: 9, agentId: 'alive-agent', inheritClaudeMd: false, createdAt: new Date().toISOString() })
    // Index points at an agent whose .md no longer exists.
    sessionAgents.setAgentForSession(SESSION, 'deleted-agent')
    const resolved = resolveAttachAgent(SESSION, 9)
    expect(resolved).toBe('alive-agent')
  })

  test('stale index AND unbound source chat falls back to the default agent', () => {
    const SESSION = '22222222-2222-2222-2222-000000000134'
    sessionAgents.setAgentForSession(SESSION, 'deleted-agent')
    const resolved = resolveAttachAgent(SESSION, 999)
    expect(resolved).toBe(agents.DEFAULT_AGENT_ID)
  })

  test('live index entry is still preferred', () => {
    const SESSION = '33333333-3333-3333-3333-000000000134'
    seedAgent('indexed-agent')
    sessionAgents.setAgentForSession(SESSION, 'indexed-agent')
    const resolved = resolveAttachAgent(SESSION, 999)
    expect(resolved).toBe('indexed-agent')
  })
})
