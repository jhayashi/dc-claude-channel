import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as teleport from '../teleport.js'
import * as bindings from '../bindings.js'

describe('projectHashForCwd', () => {
  it('transforms a POSIX path to the claude project-hash convention', () => {
    expect(teleport.projectHashForCwd('/var/home/jhayashi/src/foo')).toBe(
      '-var-home-jhayashi-src-foo'
    )
  })

  it('handles nested paths with multiple segments', () => {
    expect(teleport.projectHashForCwd('/a/b/c')).toBe('-a-b-c')
  })

  it('throws on a relative path', () => {
    expect(() => teleport.projectHashForCwd('relative/path')).toThrow()
  })
})

describe('PLUGIN_DIR', () => {
  it('points at the plugin directory containing this module', () => {
    expect(teleport.PLUGIN_DIR).toMatch(/\/plugin$/)
  })
})

describe('buildResumeCommand', () => {
  let tmpRoot: string
  let projectsRoot: string
  let bindingsRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'teleport-test-'))
    projectsRoot = join(tmpRoot, 'projects')
    bindingsRoot = join(tmpRoot, 'bindings')
    mkdirSync(projectsRoot, { recursive: true })
    mkdirSync(bindingsRoot, { recursive: true })
    teleport.setProjectsRoot(projectsRoot)
    bindings.setBindingsDir(bindingsRoot)
  })

  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  function writeSessionFile(cwd: string, sessionId: string): void {
    const dir = join(projectsRoot, teleport.projectHashForCwd(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'summary', summary: 'test session', leafUuid: sessionId }) + '\n'
    )
  }

  it('emits a cd && claude --resume command for a bound chat using PLUGIN_DIR', () => {
    const sessionId = '3b9526d5-a8f9-4ccc-a8e8-c08f6fd515ee'
    writeSessionFile(teleport.PLUGIN_DIR, sessionId)
    bindings.saveBinding({
      chatId: 42,
      sessionId,
      createdAt: new Date().toISOString(),
    })

    const result = teleport.buildResumeCommand(42)
    if ('error' in result) throw new Error(`expected success: ${result.error}`)
    expect(result.sessionId).toBe(sessionId)
    expect(result.command).toBe(`cd ${teleport.PLUGIN_DIR} && claude --resume ${sessionId}`)
    expect(result.sessionPath).toBe(join(projectsRoot, teleport.projectHashForCwd(teleport.PLUGIN_DIR), `${sessionId}.jsonl`))
  })

  it('errors when the chat has no binding', () => {
    const result = teleport.buildResumeCommand(99)
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/no session/i)
  })

  it('errors when the binding has no sessionId', () => {
    bindings.saveBinding({ chatId: 42, createdAt: new Date().toISOString() })
    const result = teleport.buildResumeCommand(42)
    expect('error' in result).toBe(true)
  })

  it('errors when the session file is missing on disk', () => {
    bindings.saveBinding({
      chatId: 42,
      sessionId: 'deadbeef-aaaa-bbbb-cccc-dddddddddddd',
      createdAt: new Date().toISOString(),
    })
    const result = teleport.buildResumeCommand(42)
    expect('error' in result).toBe(true)
    if ('error' in result) expect(result.error).toMatch(/session file not found/i)
  })
})

describe('listResumeCandidates', () => {
  let tmpRoot: string
  let projectsRoot: string
  let bindingsRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'teleport-test-'))
    projectsRoot = join(tmpRoot, 'projects')
    bindingsRoot = join(tmpRoot, 'bindings')
    mkdirSync(projectsRoot, { recursive: true })
    mkdirSync(bindingsRoot, { recursive: true })
    teleport.setProjectsRoot(projectsRoot)
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
    const out = teleport.listResumeCandidates({ limit: 10 })
    expect(out.length).toBe(2)
    expect(out[0]!.sessionId).toBe('aaa11111-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(out[1]!.sessionId).toBe('bbb22222-bbbb-bbbb-bbbb-bbbbbbbbbbbb')
  })

  it('defaults to a 48-hour window', () => {
    writeSession('-p', 'old00000-0000-0000-0000-000000000000', 3 * 24 * 60 * 60 * 1000, {})
    writeSession('-p', 'new00000-0000-0000-0000-000000000000', 1 * 60 * 60 * 1000, {})
    const out = teleport.listResumeCandidates({ limit: 10 })
    expect(out.length).toBe(1)
    expect(out[0]!.sessionId).toBe('new00000-0000-0000-0000-000000000000')
  })

  it('excludes sessions already bound to a DC chat', () => {
    writeSession('-p', 'bound000-0000-0000-0000-000000000000', 1000, {})
    writeSession('-p', 'free0000-0000-0000-0000-000000000000', 1000, {})
    bindings.saveBinding({
      chatId: 1,
      sessionId: 'bound000-0000-0000-0000-000000000000',
      createdAt: new Date().toISOString(),
    })
    const out = teleport.listResumeCandidates({ limit: 10 })
    expect(out.length).toBe(1)
    expect(out[0]!.sessionId).toBe('free0000-0000-0000-0000-000000000000')
  })

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      writeSession('-p', `sess${String(i).padStart(4, '0')}-0000-0000-0000-000000000000`, (i + 1) * 1000, {})
    }
    const out = teleport.listResumeCandidates({ limit: 3 })
    expect(out.length).toBe(3)
  })

  it('extracts CWD from the project-hash directory name', () => {
    writeSession('-home-user-src-myproject', 'cwd00000-0000-0000-0000-000000000000', 1000, {})
    const out = teleport.listResumeCandidates({ limit: 10 })
    expect(out[0]!.cwd).toBe('/home/user/src/myproject')
  })

  it('reads summary from first line if present', () => {
    writeSession('-p', 'sum00000-0000-0000-0000-000000000000', 1000, { type: 'summary', summary: 'Working on Teleport' })
    const out = teleport.listResumeCandidates({ limit: 10 })
    expect(out[0]!.summary).toBe('Working on Teleport')
  })

  it('flags isProbablyLive when mtime is within 5 minutes', () => {
    writeSession('-p', 'live0000-0000-0000-0000-000000000000', 60 * 1000, {})
    writeSession('-p', 'idle0000-0000-0000-0000-000000000000', 2 * 60 * 60 * 1000, {})
    const out = teleport.listResumeCandidates({ limit: 10 })
    const live = out.find(c => c.sessionId.startsWith('live'))
    const idle = out.find(c => c.sessionId.startsWith('idle'))
    expect(live!.isProbablyLive).toBe(true)
    expect(idle!.isProbablyLive).toBe(false)
  })

  it('estimates messageCount from file size without reading entire file', () => {
    const sessionId = 'size0000-0000-0000-0000-000000000000'
    const dir = join(projectsRoot, '-p')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${sessionId}.jsonl`)
    const body = 'x'.repeat(2000)
    writeFileSync(file, JSON.stringify({ summary: 's', filler: body }) + '\n')
    const out = teleport.listResumeCandidates({ limit: 10 })
    expect(typeof out[0]!.messageCount).toBe('number')
    expect(out[0]!.messageCount).toBeGreaterThan(0)
  })
})

describe('attachSessionToChat', () => {
  let tmpRoot: string
  let projectsRoot: string
  let bindingsRoot: string

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'teleport-test-'))
    projectsRoot = join(tmpRoot, 'projects')
    bindingsRoot = join(tmpRoot, 'bindings')
    mkdirSync(projectsRoot, { recursive: true })
    mkdirSync(bindingsRoot, { recursive: true })
    teleport.setProjectsRoot(projectsRoot)
    bindings.setBindingsDir(bindingsRoot)
  })
  afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }))

  function writeSrcSession(cwd: string, sessionId: string): string {
    const dir = join(projectsRoot, teleport.projectHashForCwd(cwd))
    mkdirSync(dir, { recursive: true })
    const p = join(dir, `${sessionId}.jsonl`)
    writeFileSync(p, JSON.stringify({ summary: 's' }) + '\n')
    return p
  }

  it('writes a binding and copies the session into the plugin hash', async () => {
    const sessionId = 'attach00-0000-0000-0000-000000000000'
    writeSrcSession('/home/user/other-proj', sessionId)

    await teleport.attachSessionToChat(42, sessionId)

    const binding = bindings.getBinding(42)
    expect(binding?.sessionId).toBe(sessionId)

    const destPath = join(projectsRoot, teleport.projectHashForCwd(teleport.PLUGIN_DIR), `${sessionId}.jsonl`)
    expect(existsSync(destPath)).toBe(true)
  })

  it('skips the copy when source and destination resolve to the same file', async () => {
    const sessionId = 'same0000-0000-0000-0000-000000000000'
    const srcPath = writeSrcSession(teleport.PLUGIN_DIR, sessionId)
    await teleport.attachSessionToChat(42, sessionId)
    expect(bindings.getBinding(42)?.sessionId).toBe(sessionId)
    expect(existsSync(srcPath)).toBe(true)
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
    await teleport.attachSessionToChat(42, sessionId)
    const b = bindings.getBinding(42)
    expect(b?.agentId).toBe('existing-agent')
    expect(b?.inheritClaudeMd).toBe(true)
    expect(b?.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(b?.sessionId).toBe(sessionId)
  })

  it('throws when the source session does not exist anywhere', async () => {
    await expect(
      teleport.attachSessionToChat(42, 'nope0000-0000-0000-0000-000000000000')
    ).rejects.toThrow(/not found/i)
  })

  it('throws when the source session is already bound to another chat', async () => {
    const sessionId = 'taken000-0000-0000-0000-000000000000'
    writeSrcSession('/x', sessionId)
    bindings.saveBinding({ chatId: 1, sessionId, createdAt: new Date().toISOString() })
    await expect(teleport.attachSessionToChat(42, sessionId)).rejects.toThrow(/already bound/i)
  })
})
