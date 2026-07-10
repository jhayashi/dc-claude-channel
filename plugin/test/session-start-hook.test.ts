import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = join(import.meta.dir, '..', 'scripts', 'session-start.sh')

let tmpHome: string
let pluginRoot: string
let stateDir: string
let approvedDir: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'dc-hook-test-'))
  pluginRoot = mkdtempSync(join(tmpdir(), 'dc-hook-plugin-'))
  stateDir = join(tmpHome, '.claude', 'channels', 'deltachat')
  approvedDir = join(stateDir, 'approved')
})

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  try { rmSync(pluginRoot, { recursive: true, force: true }) } catch {}
})

function runHook(): { stdout: string; exitCode: number } {
  // These tests exercise the paired/unpaired banner logic, which only runs
  // once the channel flag is present. Under `bun test` the ancestor walk can't
  // find the flag (no `claude --dangerously-load-development-channels` parent),
  // so set the explicit override; otherwise the hook short-circuits to the
  // "channel flag MISSING" banner and preempts what we're testing.
  const proc = Bun.spawnSync([HOOK], {
    env: {
      ...process.env,
      HOME: tmpHome,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      DC_CHANNEL_FLAG_PRESENT: '1',
    },
  })
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? -1 }
}

test('unpaired → unpaired banner', () => {
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).toContain('Delta Chat plugin is ready')
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('no chat is paired')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('/deltachat:setup')
})

test('paired (current layout: bindings/*.json) → exits 0 with no output', () => {
  // #131: v1.3 retired approved/ (renamed approved.legacy/ at first boot);
  // the post-v1.3 pairing source of truth is bindings/ — dc_access_pair
  // auto-binds the paired chat, so a binding implies a paired install.
  const bindingsDir = join(stateDir, 'bindings')
  mkdirSync(bindingsDir, { recursive: true })
  writeFileSync(join(bindingsDir, '12.json'), JSON.stringify({ chatId: 12, agentId: 'claude-code' }))
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('paired (pre-v1.3 legacy layout: approved/) → exits 0 with no output', () => {
  // Upgrade window: an install that paired pre-v1.3 and has not yet booted
  // the new dispatcher still has approved/ — recognize it.
  mkdirSync(approvedDir, { recursive: true })
  writeFileSync(join(approvedDir, '12345'), '{}')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('paired (retired layout: approved.legacy/) → exits 0 with no output', () => {
  // A v1.3+ boot renamed approved/ → approved.legacy/. Even with no
  // binding files (edge: user unbound everything), the retired dir still
  // proves this install completed pairing — stay silent.
  const legacyDir = join(stateDir, 'approved.legacy')
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(join(legacyDir, '12345'), '{}')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('hook no longer surfaces install state — paired is silent regardless', () => {
  // Even if deps look incomplete (no bun.lock at all), a paired user sees
  // nothing. Install state is handled transparently by server.ts's readiness
  // gate; the hook stays out of it.
  const bindingsDir = join(stateDir, 'bindings')
  mkdirSync(bindingsDir, { recursive: true })
  writeFileSync(join(bindingsDir, '12.json'), JSON.stringify({ chatId: 12, agentId: 'claude-code' }))
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('empty bindings dir alone is NOT paired — unpaired banner shows', () => {
  mkdirSync(join(stateDir, 'bindings'), { recursive: true })
  const { stdout } = runHook()
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).toContain('Delta Chat plugin is ready')
})

test('unpaired banner does not mention install status', () => {
  const { stdout } = runHook()
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).not.toContain('installing')
  expect(parsed.systemMessage).not.toContain('native dependencies')
})
