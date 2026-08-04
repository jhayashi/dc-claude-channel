import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { logToolCall, logTurn, logPermission, logWebXDC, logSubagentStderr, logPermissionRelayFailure, buildArgPreview, getEventDir, setEventDir, type ToolCallEvent, type TurnEvent, type PermissionEvent, type WebXDCEvent, type SubagentStderrEvent, type PermissionRelayFailureEvent } from '../events.js'

function baseEvent(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    ts: '2026-04-20T18:42:13.021Z',
    source: 'subagent',
    tool: 'dc_send',
    callerChatId: 26,
    callerContactId: 11,
    argChatId: 26,
    targetOwner: 11,
    durationMs: 47,
    ok: true,
    errorCode: null,
    argPreview: 'chat_id=26',
    ...overrides,
  }
}

describe('events.logToolCall', () => {
  let dir: string
  let prevDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-test-'))
    prevDir = getEventDir()
    setEventDir(dir)
  })

  afterEach(() => {
    setEventDir(prevDir)
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('writes one JSONL line per event with all fields', () => {
    logToolCall(baseEvent())
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]).toBe('tools-2026-04-20.log')
    const contents = readFileSync(join(dir, files[0]), 'utf-8')
    expect(contents.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(contents.trim())
    expect(parsed).toMatchObject({
      ts: '2026-04-20T18:42:13.021Z',
      source: 'subagent',
      tool: 'dc_send',
      callerChatId: 26,
      callerContactId: 11,
      argChatId: 26,
      targetOwner: 11,
      durationMs: 47,
      ok: true,
      errorCode: null,
      argPreview: 'chat_id=26',
    })
  })

  it('buckets events by UTC date across rollover', () => {
    logToolCall(baseEvent({ ts: '2026-04-20T23:59:59.500Z' }))
    logToolCall(baseEvent({ ts: '2026-04-21T00:00:00.500Z' }))
    const files = readdirSync(dir).sort()
    expect(files).toEqual(['tools-2026-04-20.log', 'tools-2026-04-21.log'])
  })

  it('appends multiple events to the same file on the same day', () => {
    logToolCall(baseEvent({ ts: '2026-04-20T10:00:00.000Z', tool: 'a' }))
    logToolCall(baseEvent({ ts: '2026-04-20T20:00:00.000Z', tool: 'b' }))
    const contents = readFileSync(join(dir, 'tools-2026-04-20.log'), 'utf-8')
    const lines = contents.split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).tool).toBe('a')
    expect(JSON.parse(lines[1]).tool).toBe('b')
  })

  it('swallows write errors and calls onWriteError', () => {
    // Create a regular file where the event dir would need to be created.
    // mkdirSync will fail with ENOTDIR — the logger should swallow it.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    setEventDir(join(blocker, 'events'))
    let err: unknown = null
    expect(() => logToolCall(baseEvent(), (e) => { err = e })).not.toThrow()
    expect(err).not.toBe(null)
  })

  it('persists v1.3 capability fields when present (slice 3)', () => {
    logToolCall(baseEvent({
      tool: 'dc_send_file',
      requiredCapability: 'private_data_write',
      originatorCapabilities: ['chat', 'low_stakes_*'],
      capabilityDecision: 'would_deny',
    }))
    const files = readdirSync(dir)
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed.requiredCapability).toBe('private_data_write')
    expect(parsed.originatorCapabilities).toEqual(['chat', 'low_stakes_*'])
    expect(parsed.capabilityDecision).toBe('would_deny')
  })

  it('omits v1.3 capability fields gracefully when absent (pre-slice-3 records)', () => {
    // The fields are optional. logToolCall must accept events without
    // them and the JSON line must round-trip cleanly.
    logToolCall(baseEvent())
    const files = readdirSync(dir)
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed.requiredCapability).toBeUndefined()
    expect(parsed.originatorCapabilities).toBeUndefined()
    expect(parsed.capabilityDecision).toBeUndefined()
  })
})

describe('events.logSubagentStderr', () => {
  let dir: string
  let prevDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-test-'))
    prevDir = getEventDir()
    setEventDir(dir)
  })

  afterEach(() => {
    setEventDir(prevDir)
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('writes stderr chunks to subagent-stderr-<date>.log', () => {
    logSubagentStderr({
      ts: '2026-05-31T00:00:02.456Z',
      chatId: 14,
      subagentId: 'sub-14-abc123',
      kind: 'stderr',
      text: 'panic: runtime error\nstack trace ...',
    })
    const files = readdirSync(dir)
    expect(files).toEqual(['subagent-stderr-2026-05-31.log'])
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed).toMatchObject({
      chatId: 14,
      subagentId: 'sub-14-abc123',
      kind: 'stderr',
      text: 'panic: runtime error\nstack trace ...',
    })
  })

  it('writes an exit marker with the exit code', () => {
    logSubagentStderr({
      ts: '2026-05-31T00:00:02.500Z',
      chatId: 14,
      subagentId: 'sub-14-abc123',
      kind: 'exit',
      exitCode: 137,
    })
    const files = readdirSync(dir)
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed.kind).toBe('exit')
    expect(parsed.exitCode).toBe(137)
  })

  it('preserves null exit code for signal-kill (no exit code)', () => {
    logSubagentStderr({
      ts: '2026-05-31T00:00:02.500Z',
      chatId: 14,
      subagentId: 'sub-14-abc123',
      kind: 'exit',
      exitCode: null,
    })
    const files = readdirSync(dir)
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed.exitCode).toBe(null)
  })
})

describe('events.logPermissionRelayFailure', () => {
  let dir: string
  let prevDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'events-test-'))
    prevDir = getEventDir()
    setEventDir(dir)
  })

  afterEach(() => {
    setEventDir(prevDir)
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  function baseRelayFailure(overrides: Partial<PermissionRelayFailureEvent> = {}): PermissionRelayFailureEvent {
    return {
      ts: '2026-08-04T15:00:00.000Z',
      requestId: 'p-1234-5678',
      chatId: 10,
      subagentId: 'sub-10-abc123',
      tool: 'Bash',
      stage: 'socket_error',
      exitCode: 11,
      detail: 'connect ECONNREFUSED',
      ...overrides,
    }
  }

  it('writes one JSONL line to permission-relay-<date>.log with all fields', () => {
    logPermissionRelayFailure(baseRelayFailure())
    const files = readdirSync(dir)
    expect(files).toEqual(['permission-relay-2026-08-04.log'])
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed).toMatchObject(baseRelayFailure())
  })

  it('records the shell-timeout catch-all stage with a null-safe chatId/subagentId', () => {
    logPermissionRelayFailure(baseRelayFailure({
      stage: 'shell_timeout_or_unknown_rc',
      exitCode: 124,
      chatId: null,
      subagentId: null,
      detail: 'shell wrapper caught rc=124 (timeout or client never self-reported)',
    }))
    const files = readdirSync(dir)
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed.stage).toBe('shell_timeout_or_unknown_rc')
    expect(parsed.exitCode).toBe(124)
    expect(parsed.chatId).toBe(null)
    expect(parsed.subagentId).toBe(null)
  })

  it('swallows write errors like the other streams', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    setEventDir(join(blocker, 'events'))
    let err: unknown = null
    expect(() => logPermissionRelayFailure(baseRelayFailure(), (e) => { err = e })).not.toThrow()
    expect(err).not.toBe(null)
  })
})

describe('events.buildArgPreview', () => {
  it('redacts sensitive keys', () => {
    const preview = buildArgPreview({ chat_id: '26', text: 'secret data', title: 'hello' })
    expect(preview).toContain('text=<redacted>')
    expect(preview).toContain('chat_id=26')
    expect(preview).toContain('title=hello')
    expect(preview).not.toContain('secret data')
  })

  it('redacts content, body, secret, password, token, email', () => {
    const preview = buildArgPreview({
      content: 'a', body: 'b', secret: 'c', password: 'd', token: 'e', email: 'f',
    })
    for (const k of ['content', 'body', 'secret', 'password', 'token', 'email']) {
      expect(preview).toContain(`${k}=<redacted>`)
    }
  })

  it('clips per-value at 40 chars with ellipsis', () => {
    const long = 'x'.repeat(100)
    const preview = buildArgPreview({ title: long })
    expect(preview).toContain('xxx...')
    expect(preview).not.toContain(long)
  })

  it('caps total preview at 120 chars', () => {
    const args: Record<string, unknown> = {}
    for (let i = 0; i < 30; i++) args[`k${i}`] = 'v'
    const preview = buildArgPreview(args)
    expect(preview.length).toBeLessThanOrEqual(120)
  })

  it('handles null/undefined/non-string values', () => {
    const preview = buildArgPreview({ a: null, b: undefined, c: 42, d: true, e: { x: 1 } })
    expect(preview).toContain('a=null')
    expect(preview).toContain('b=undefined')
    expect(preview).toContain('c=42')
    expect(preview).toContain('d=true')
    expect(preview).toContain('e={"x":1}')
  })

  it('returns empty string for null/undefined/non-object', () => {
    expect(buildArgPreview(null)).toBe('')
    expect(buildArgPreview(undefined)).toBe('')
  })
})

function baseTurn(overrides: Partial<TurnEvent> = {}): TurnEvent {
  return {
    ts: '2026-04-20T19:00:00.000Z',
    turnId: 'abc123',
    chatId: 7,
    agentId: 'marketing-agent',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    spawnColdMs: 6100,
    durationMs: 4200,
    toolCalls: 3,
    exitReason: 'completed',
    ...overrides,
  }
}

describe('events.logTurn', () => {
  let dir: string
  let prevDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'turns-test-'))
    prevDir = getEventDir()
    setEventDir(dir)
  })

  afterEach(() => {
    setEventDir(prevDir)
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('writes one JSONL line per turn to turns-<date>.log', () => {
    logTurn(baseTurn())
    const files = readdirSync(dir)
    expect(files).toEqual(['turns-2026-04-20.log'])
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed).toMatchObject({
      turnId: 'abc123',
      chatId: 7,
      agentId: 'marketing-agent',
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      spawnColdMs: 6100,
      durationMs: 4200,
      toolCalls: 3,
      exitReason: 'completed',
    })
  })

  it('keeps tool and turn streams in separate files on the same day', () => {
    logToolCall({
      ts: '2026-04-20T10:00:00.000Z', source: 'subagent', tool: 'dc_send',
      callerChatId: 7, callerContactId: 11, argChatId: 7, targetOwner: 11,
      durationMs: 47, ok: true, errorCode: null, argPreview: 'chat_id=7',
    })
    logTurn(baseTurn({ ts: '2026-04-20T10:01:00.000Z' }))
    const files = readdirSync(dir).sort()
    expect(files).toEqual(['tools-2026-04-20.log', 'turns-2026-04-20.log'])
  })

  it('accepts all seven exit-reason taxonomy values', () => {
    const reasons: TurnEvent['exitReason'][] = [
      'completed', 'idle', 'lru_evict', 'turn_timeout', 'crash', 'user_abort', 'resume_fallback',
    ]
    for (const r of reasons) logTurn(baseTurn({ exitReason: r, turnId: `t-${r}` }))
    const lines = readFileSync(join(dir, 'turns-2026-04-20.log'), 'utf-8').split('\n').filter(Boolean)
    expect(lines.length).toBe(reasons.length)
    expect(lines.map((l) => JSON.parse(l).exitReason)).toEqual(reasons)
  })

  it('swallows write errors', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    setEventDir(join(blocker, 'events'))
    let err: unknown = null
    expect(() => logTurn(baseTurn(), (e) => { err = e })).not.toThrow()
    expect(err).not.toBe(null)
  })
})

function basePermission(overrides: Partial<PermissionEvent> = {}): PermissionEvent {
  return {
    ts: '2026-04-20T19:30:00.000Z',
    chatId: 42,
    agentId: 'marketing-agent',
    tool: 'Bash',
    inputPreview: 'command=ls -la',
    verdict: 'allow',
    reason: 'user_allow',
    timedOut: false,
    durationMs: 4200,
    ...overrides,
  }
}

describe('events.logPermission', () => {
  let dir: string
  let prevDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'perms-test-'))
    prevDir = getEventDir()
    setEventDir(dir)
  })

  afterEach(() => {
    setEventDir(prevDir)
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('writes one JSONL line per permission decision to permissions-<date>.log', () => {
    logPermission(basePermission())
    const files = readdirSync(dir)
    expect(files).toEqual(['permissions-2026-04-20.log'])
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed).toMatchObject({
      chatId: 42,
      agentId: 'marketing-agent',
      tool: 'Bash',
      inputPreview: 'command=ls -la',
      verdict: 'allow',
      reason: 'user_allow',
      timedOut: false,
      durationMs: 4200,
    })
  })

  it('keeps tool/turn/permission streams in separate files on the same day', () => {
    logToolCall({
      ts: '2026-04-20T10:00:00.000Z', source: 'subagent', tool: 'dc_send',
      callerChatId: 7, callerContactId: 11, argChatId: 7, targetOwner: 11,
      durationMs: 47, ok: true, errorCode: null, argPreview: 'chat_id=7',
    })
    logTurn(baseTurn({ ts: '2026-04-20T10:01:00.000Z' }))
    logPermission(basePermission({ ts: '2026-04-20T10:02:00.000Z' }))
    const files = readdirSync(dir).sort()
    expect(files).toEqual([
      'permissions-2026-04-20.log',
      'tools-2026-04-20.log',
      'turns-2026-04-20.log',
    ])
  })

  it('accepts all six permission-reason values (v1.3 adds capability_deny + capability_lookup_error + capability_invalid_requestor)', () => {
    const reasons: PermissionEvent['reason'][] = [
      'user_allow', 'user_deny', 'skip_auto', 'capability_deny', 'capability_lookup_error', 'capability_invalid_requestor',
    ]
    for (const r of reasons) {
      logPermission(basePermission({
        reason: r,
        verdict: r === 'user_allow' || r === 'skip_auto' ? 'allow' : 'deny',
      }))
    }
    const lines = readFileSync(join(dir, 'permissions-2026-04-20.log'), 'utf-8')
      .split('\n').filter(Boolean)
    expect(lines.length).toBe(reasons.length)
    expect(lines.map((l) => JSON.parse(l).reason)).toEqual(reasons)
  })

  it('persists v1.3 capability fields on capability_deny entries (slice 4)', () => {
    logPermission(basePermission({
      tool: 'dc_send_file',
      verdict: 'deny',
      reason: 'capability_deny',
      durationMs: 0,
      originatorContactId: 50,
      requiredCapability: 'private_data_write',
      originatorCapabilities: ['chat', 'low_stakes_*'],
    }))
    const files = readdirSync(dir)
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed.reason).toBe('capability_deny')
    expect(parsed.verdict).toBe('deny')
    expect(parsed.originatorContactId).toBe(50)
    expect(parsed.requiredCapability).toBe('private_data_write')
    expect(parsed.originatorCapabilities).toEqual(['chat', 'low_stakes_*'])
  })

  it('swallows write errors', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    setEventDir(join(blocker, 'events'))
    let err: unknown = null
    expect(() => logPermission(basePermission(), (e) => { err = e })).not.toThrow()
    expect(err).not.toBe(null)
  })
})

function baseWebXDC(overrides: Partial<WebXDCEvent> = {}): WebXDCEvent {
  return {
    ts: '2026-04-20T20:00:00.000Z',
    msgId: 777,
    chatId: 42,
    appId: 'permissions',
    ownerVerified: true,
    payloadType: 'response',
    payloadSize: 123,
    ...overrides,
  }
}

describe('events.logWebXDC', () => {
  let dir: string
  let prevDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'webxdc-test-'))
    prevDir = getEventDir()
    setEventDir(dir)
  })

  afterEach(() => {
    setEventDir(prevDir)
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('writes one JSONL line per update to webxdc-<date>.log', () => {
    logWebXDC(baseWebXDC())
    const files = readdirSync(dir)
    expect(files).toEqual(['webxdc-2026-04-20.log'])
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed).toMatchObject({
      msgId: 777,
      chatId: 42,
      appId: 'permissions',
      ownerVerified: true,
      payloadType: 'response',
      payloadSize: 123,
    })
  })

  it('logs dropped updates with ownerVerified=false', () => {
    logWebXDC(baseWebXDC({ ownerVerified: false, payloadType: null, payloadSize: 45 }))
    const line = readFileSync(join(dir, 'webxdc-2026-04-20.log'), 'utf-8').trim()
    const parsed = JSON.parse(line)
    expect(parsed.ownerVerified).toBe(false)
    expect(parsed.payloadType).toBe(null)
  })

  it('keeps all four event streams in separate files on the same day', () => {
    logToolCall({
      ts: '2026-04-20T10:00:00.000Z', source: 'subagent', tool: 'dc_send',
      callerChatId: 7, callerContactId: 11, argChatId: 7, targetOwner: 11,
      durationMs: 47, ok: true, errorCode: null, argPreview: 'chat_id=7',
    })
    logTurn(baseTurn({ ts: '2026-04-20T10:01:00.000Z' }))
    logPermission(basePermission({ ts: '2026-04-20T10:02:00.000Z' }))
    logWebXDC(baseWebXDC({ ts: '2026-04-20T10:03:00.000Z' }))
    const files = readdirSync(dir).sort()
    expect(files).toEqual([
      'permissions-2026-04-20.log',
      'tools-2026-04-20.log',
      'turns-2026-04-20.log',
      'webxdc-2026-04-20.log',
    ])
  })

  it('swallows write errors', () => {
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    setEventDir(join(blocker, 'events'))
    let err: unknown = null
    expect(() => logWebXDC(baseWebXDC(), (e) => { err = e })).not.toThrow()
    expect(err).not.toBe(null)
  })
})

describe('events.logRoleAssignment (v1.3 slice 6)', () => {
  let dir: string
  let prevDir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'role-events-test-'))
    prevDir = getEventDir()
    setEventDir(dir)
  })

  afterEach(() => {
    setEventDir(prevDir)
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('writes a role-assignment line to the permissions stream', async () => {
    const { logRoleAssignment } = await import('../events.js')
    logRoleAssignment({
      ts: '2026-05-01T10:00:00.000Z',
      assigneeContactId: 60,
      assignedRole: 'subscriber',
      previousRole: null,
      assignerContactId: null,
      reason: 'terminal_pair',
    })
    const files = readdirSync(dir)
    expect(files).toEqual(['permissions-2026-05-01.log'])
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed).toMatchObject({
      assigneeContactId: 60,
      assignedRole: 'subscriber',
      previousRole: null,
      assignerContactId: null,
      reason: 'terminal_pair',
    })
  })

  it('records previousRole on transitions (downgrade/upgrade)', async () => {
    const { logRoleAssignment } = await import('../events.js')
    logRoleAssignment({
      ts: '2026-05-01T10:00:00.000Z',
      assigneeContactId: 60,
      assignedRole: 'family-member',
      previousRole: 'subscriber',
      assignerContactId: 50,
      reason: 'picked',
    })
    const files = readdirSync(dir)
    const parsed = JSON.parse(readFileSync(join(dir, files[0]), 'utf-8').trim())
    expect(parsed.previousRole).toBe('subscriber')
    expect(parsed.assignedRole).toBe('family-member')
    expect(parsed.reason).toBe('picked')
  })
})
