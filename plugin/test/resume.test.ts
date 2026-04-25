import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as resume from '../resume.js'
import * as bindings from '../bindings.js'

describe('projectHashForCwd', () => {
  it('transforms a POSIX path to the claude project-hash convention', () => {
    expect(resume.projectHashForCwd('/var/home/jhayashi/src/foo')).toBe(
      '-var-home-jhayashi-src-foo'
    )
  })

  it('handles nested paths with multiple segments', () => {
    expect(resume.projectHashForCwd('/a/b/c')).toBe('-a-b-c')
  })

  it('throws on a relative path', () => {
    expect(() => resume.projectHashForCwd('relative/path')).toThrow()
  })
})

describe('PLUGIN_DIR', () => {
  it('points at the plugin directory containing this module', () => {
    expect(resume.PLUGIN_DIR).toMatch(/\/plugin$/)
  })
})

describe('sessionFileExists', () => {
  let tmpRoot: string
  let projectsRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'session-exists-test-'))
    projectsRoot = join(tmpRoot, 'projects')
    mkdirSync(projectsRoot, { recursive: true })
    resume.setProjectsRoot(projectsRoot)
  })

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  it('returns true when the session jsonl exists under the cwd hash', () => {
    const cwd = '/home/user/src/proj'
    const sessionId = '3b9526d5-a8f9-4ccc-a8e8-c08f6fd515ee'
    const dir = join(projectsRoot, resume.projectHashForCwd(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${sessionId}.jsonl`), '')
    expect(resume.sessionFileExists(cwd, sessionId)).toBe(true)
  })

  it('returns false when the cwd hash dir is absent', () => {
    expect(resume.sessionFileExists('/no/such/cwd', '3b9526d5-a8f9-4ccc-a8e8-c08f6fd515ee')).toBe(false)
  })

  it('returns false when the dir exists but the session file does not (ghost session)', () => {
    const cwd = '/home/user/src/proj'
    mkdirSync(join(projectsRoot, resume.projectHashForCwd(cwd)), { recursive: true })
    expect(resume.sessionFileExists(cwd, 'deadbeef-aaaa-bbbb-cccc-dddddddddddd')).toBe(false)
  })
})

describe('buildResumeCommand', () => {
  let tmpRoot: string
  let projectsRoot: string
  let bindingsRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'resume-test-'))
    projectsRoot = join(tmpRoot, 'projects')
    bindingsRoot = join(tmpRoot, 'bindings')
    mkdirSync(projectsRoot, { recursive: true })
    mkdirSync(bindingsRoot, { recursive: true })
    resume.setProjectsRoot(projectsRoot)
    bindings.setBindingsDir(bindingsRoot)
  })

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  function writeSessionFile(cwd: string, sessionId: string): void {
    const dir = join(projectsRoot, resume.projectHashForCwd(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'summary', summary: 'test session', leafUuid: sessionId }) + '\n'
    )
  }

  it('emits a cd && claude --resume command using the binding workingDir', () => {
    const sessionId = '3b9526d5-a8f9-4ccc-a8e8-c08f6fd515ee'
    const workingDir = '/home/user/src/myproject'
    writeSessionFile(workingDir, sessionId)
    bindings.saveBinding({
      chatId: 42,
      sessionId,
      workingDir,
      createdAt: new Date().toISOString(),
    })

    const result = resume.buildResumeCommand(42)
    if ('error' in result) throw new Error(`expected success: ${result.error}`)
    expect(result.kind).toBe('resume')
    expect(result.sessionId).toBe(sessionId)
    expect(result.command).toBe(`cd ${workingDir} && claude --resume ${sessionId}`)
    expect(result.sessionPath).toBe(join(projectsRoot, resume.projectHashForCwd(workingDir), `${sessionId}.jsonl`))
  })

  it('includes --name flag when chatName is provided', () => {
    const sessionId = '3b9526d5-a8f9-4ccc-a8e8-c08f6fd515ee'
    const workingDir = '/home/user/src/myproject'
    writeSessionFile(workingDir, sessionId)
    bindings.saveBinding({
      chatId: 42,
      sessionId,
      workingDir,
      createdAt: new Date().toISOString(),
    })

    const result = resume.buildResumeCommand(42, { chatName: 'My Agent' })
    if ('error' in result) throw new Error(`expected success: ${result.error}`)
    expect(result.command).toContain("--name 'My Agent'")
    expect(result.sessionName).toBe('My Agent')
  })

  it('shell-quotes chat names with special characters', () => {
    const sessionId = '3b9526d5-a8f9-4ccc-a8e8-c08f6fd515ee'
    const workingDir = '/home/user/src/myproject'
    writeSessionFile(workingDir, sessionId)
    bindings.saveBinding({
      chatId: 42,
      sessionId,
      workingDir,
      createdAt: new Date().toISOString(),
    })

    const result = resume.buildResumeCommand(42, { chatName: "Joe's Chat" })
    if ('error' in result) throw new Error(`expected success: ${result.error}`)
    expect(result.command).toContain("--name 'Joe'\\''s Chat'")
  })

  it('falls back to PLUGIN_DIR when the binding has no workingDir (legacy v1.0.1 and earlier)', () => {
    // Pre-refactor, DC subagents spawned with cwd = PLUGIN_DIR, so their
    // session files live under projectHashForCwd(PLUGIN_DIR). Legacy
    // bindings upgrading past the refactor must resolve to that dir.
    const sessionId = '3b9526d5-a8f9-4ccc-a8e8-c08f6fd515ee'
    writeSessionFile(resume.PLUGIN_DIR, sessionId)
    bindings.saveBinding({
      chatId: 42,
      sessionId,
      createdAt: new Date().toISOString(),
    })

    const result = resume.buildResumeCommand(42)
    if ('error' in result) throw new Error(`expected success: ${result.error}`)
    expect(result.command).toBe(`cd ${resume.PLUGIN_DIR} && claude --resume ${sessionId}`)
  })

  it('errors when the chat has no binding', () => {
    const result = resume.buildResumeCommand(99)
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/no agent paired/i)
  })

  it('falls back to a fresh terminal session when binding has no sessionId', () => {
    const workingDir = '/home/user/src/myproject'
    bindings.saveBinding({ chatId: 42, workingDir, createdAt: new Date().toISOString() })
    const result = resume.buildResumeCommand(42, { chatName: 'My Agent' })
    if ('error' in result) throw new Error(`expected success: ${result.error}`)
    expect(result.kind).toBe('fresh')
    expect(result.sessionId).toBeNull()
    expect(result.command).toBe(`cd ${workingDir} && claude --name 'My Agent'`)
  })

  it('falls back to a fresh terminal session when the session file is missing', () => {
    bindings.saveBinding({
      chatId: 42,
      sessionId: 'deadbeef-aaaa-bbbb-cccc-dddddddddddd',
      workingDir: '/home/user/src/myproject',
      createdAt: new Date().toISOString(),
    })
    const result = resume.buildResumeCommand(42)
    if ('error' in result) throw new Error(`expected success: ${result.error}`)
    expect(result.kind).toBe('fresh')
    expect(result.sessionId).toBeNull()
    expect(result.command).toBe('cd /home/user/src/myproject && claude')
  })
})

describe('listResumeCandidates', () => {
  let tmpRoot: string
  let projectsRoot: string
  let bindingsRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'resume-test-'))
    projectsRoot = join(tmpRoot, 'projects')
    bindingsRoot = join(tmpRoot, 'bindings')
    mkdirSync(projectsRoot, { recursive: true })
    mkdirSync(bindingsRoot, { recursive: true })
    resume.setProjectsRoot(projectsRoot)
    bindings.setBindingsDir(bindingsRoot)
  })
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  function writeSession(cwdHash: string, sessionId: string, ageMs: number, line1: object): string {
    const dir = join(projectsRoot, cwdHash)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    writeFileSync(file, JSON.stringify(line1) + '\n')
    const when = (Date.now() - ageMs) / 1000
    utimesSync(file, when, when)
    return file
  }

  it('lists recent sessions, newest first', () => {
    writeSession('-home-user-proj-a', 'aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 1 * 60 * 1000, { summary: 'Session A' })
    writeSession('-home-user-proj-b', 'bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 5 * 60 * 1000, { summary: 'Session B' })
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out.length).toBe(2)
    expect(out[0]!.sessionId).toBe('aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(out[1]!.sessionId).toBe('bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  })

  it('defaults to a 5-day window', () => {
    writeSession('-p', 'old00000-0000-0000-0000-000000000000', 6 * 24 * 60 * 60 * 1000, {})
    writeSession('-p', 'new00000-0000-0000-0000-000000000000', 1 * 60 * 60 * 1000, {})
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out.length).toBe(1)
    expect(out[0]!.sessionId).toBe('new00000-0000-0000-0000-000000000000')
  })

  it('includes orphan DC-born sessions when they are not currently bound', () => {
    const pluginHash = resume.projectHashForCwd(resume.PLUGIN_DIR)
    writeSession(pluginHash, 'dc000000-0000-0000-0000-000000000000', 1000, {})
    writeSession('-home-user-proj', 'tty00000-0000-0000-0000-000000000000', 1000, {})
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out.length).toBe(2)
  })

  it('excludes sessions already bound to a DC chat', () => {
    writeSession('-p', 'bound000-0000-0000-0000-000000000000', 1000, {})
    writeSession('-p', 'free0000-0000-0000-0000-000000000000', 1000, {})
    bindings.saveBinding({
      chatId: 1,
      sessionId: 'bound000-0000-0000-0000-000000000000',
      createdAt: new Date().toISOString(),
    })
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out.length).toBe(1)
    expect(out[0]!.sessionId).toBe('free0000-0000-0000-0000-000000000000')
  })

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      writeSession('-p', `sess${String(i).padStart(4, '0')}-0000-0000-0000-000000000000`, (i + 1) * 1000, {})
    }
    const out = resume.listResumeCandidates({ limit: 3 })
    expect(out.length).toBe(3)
  })

  it('extracts CWD from the project-hash directory name', () => {
    writeSession('-home-user-src-myproject', 'cwd00000-0000-0000-0000-000000000000', 1000, {})
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out[0]!.cwd).toBe('/home/user/src/myproject')
  })

  it('reads summary from first line if present', () => {
    writeSession('-p', 'sum00000-0000-0000-0000-000000000000', 1000, { type: 'summary', summary: 'Working on Resume' })
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out[0]!.summary).toBe('Working on Resume')
  })

  it('reads sessionName from custom-title entry in .jsonl', () => {
    const sessionId = 'name0000-0000-0000-0000-000000000000'
    const dir = join(projectsRoot, '-p')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    const lines = [
      JSON.stringify({ type: 'custom-title', customTitle: 'My Terminal Session', sessionId }),
      JSON.stringify({ type: 'agent-name', agentName: 'My Terminal Session', sessionId }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
    ]
    writeFileSync(file, lines.join('\n') + '\n')
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out[0]!.sessionName).toBe('My Terminal Session')
  })

  it('returns null sessionName when no custom-title entry exists', () => {
    writeSession('-p', 'noname00-0000-0000-0000-000000000000', 1000, { type: 'permission-mode', permissionMode: 'default' })
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(out[0]!.sessionName).toBeNull()
  })

  it('excludes sessions with a live fd (single-writer guard)', () => {
    writeSession('-p', 'live0000-0000-0000-0000-000000000000', 60 * 1000, {})
    writeSession('-p', 'idle0000-0000-0000-0000-000000000000', 60 * 1000, {})
    // Hold the "live" file open so fuser detects it.
    const { openSync, closeSync } = require('node:fs')
    const livePath = join(projectsRoot, '-p', 'live0000-0000-0000-0000-000000000000.jsonl')
    const fd = openSync(livePath, 'r')
    try {
      const out = resume.listResumeCandidates({ limit: 10 })
      expect(out.find(c => c.sessionId.startsWith('live'))).toBeUndefined()
      expect(out.find(c => c.sessionId.startsWith('idle'))).toBeDefined()
    } finally {
      closeSync(fd)
    }
  })

  it('estimates messageCount from file size without reading entire file', () => {
    const sessionId = 'size0000-0000-0000-0000-000000000000'
    const dir = join(projectsRoot, '-p')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    const body = 'x'.repeat(2000)
    writeFileSync(file, JSON.stringify({ summary: 's', filler: body }) + '\n')
    const out = resume.listResumeCandidates({ limit: 10 })
    expect(typeof out[0]!.messageCount).toBe('number')
    expect(out[0]!.messageCount).toBeGreaterThan(0)
  })
})

describe('attachSessionToChat', () => {
  let tmpRoot: string
  let projectsRoot: string
  let bindingsRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'resume-test-'))
    projectsRoot = join(tmpRoot, 'projects')
    bindingsRoot = join(tmpRoot, 'bindings')
    mkdirSync(projectsRoot, { recursive: true })
    mkdirSync(bindingsRoot, { recursive: true })
    resume.setProjectsRoot(projectsRoot)
    bindings.setBindingsDir(bindingsRoot)
  })
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  function writeSrcSession(cwd: string, sessionId: string): string {
    const dir = join(projectsRoot, resume.projectHashForCwd(cwd))
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `${sessionId}.jsonl`)
    writeFileSync(
      p,
      JSON.stringify({ summary: 's' }) + '\n' +
        JSON.stringify({ type: 'user', cwd, sessionId }) + '\n',
    )
    return p
  }

  it('records workingDir from the source cwd and leaves the .jsonl in place', async () => {
    const sessionId = 'attach00-0000-0000-0000-000000000000'
    const srcCwd = '/home/user/other-proj'
    const srcPath = writeSrcSession(srcCwd, sessionId)

    await resume.attachSessionToChat(42, sessionId)

    const binding = bindings.getBinding(42)
    expect(binding?.sessionId).toBe(sessionId)
    expect(binding?.workingDir).toBe(srcCwd)

    // Source file stays put; no copy is made anywhere else.
    expect(existsSync(srcPath)).toBe(true)
    const pluginDestPath = join(projectsRoot, resume.projectHashForCwd(resume.PLUGIN_DIR), `${sessionId}.jsonl`)
    expect(existsSync(pluginDestPath)).toBe(false)
  })

  it('preserves existing binding fields (agentId, inheritClaudeMd) when attaching', async () => {
    const sessionId = 'preserve-0000-0000-0000-000000000000'
    writeSrcSession('/somewhere', sessionId)
    bindings.saveBinding({
      chatId: 42,
      agentId: 'existing-agent',
      inheritClaudeMd: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await resume.attachSessionToChat(42, sessionId)
    const b = bindings.getBinding(42)
    expect(b?.agentId).toBe('existing-agent')
    expect(b?.inheritClaudeMd).toBe(true)
    expect(b?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(b?.sessionId).toBe(sessionId)
    expect(b?.workingDir).toBe('/somewhere')
  })

  it('throws when the source session does not exist anywhere', async () => {
    await expect(
      resume.attachSessionToChat(42, 'nope0000-0000-0000-0000-000000000000')
    ).rejects.toThrow(/not found/i)
  })

  it('throws when the source session is already bound to another chat', async () => {
    const sessionId = 'taken000-0000-0000-0000-000000000000'
    writeSrcSession('/x', sessionId)
    bindings.saveBinding({ chatId: 1, sessionId, createdAt: new Date().toISOString() })
    await expect(resume.attachSessionToChat(42, sessionId)).rejects.toThrow(/already bound/i)
  })
})
