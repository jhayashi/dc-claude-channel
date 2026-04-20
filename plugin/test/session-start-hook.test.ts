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
  const proc = Bun.spawnSync([HOOK], {
    env: { ...process.env, HOME: tmpHome, CLAUDE_PLUGIN_ROOT: pluginRoot },
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

test('paired chat present → exits 0 with no output', () => {
  mkdirSync(approvedDir, { recursive: true })
  writeFileSync(join(approvedDir, '12345'), '{}')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('hook no longer surfaces install state — paired is silent regardless', () => {
  // Even if deps look incomplete (no bun.lock at all), a paired user sees
  // nothing. Install state is handled transparently by server.ts's readiness
  // gate; the hook stays out of it.
  mkdirSync(approvedDir, { recursive: true })
  writeFileSync(join(approvedDir, '12345'), '{}')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('unpaired banner does not mention install status', () => {
  const { stdout } = runHook()
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).not.toContain('installing')
  expect(parsed.systemMessage).not.toContain('native dependencies')
})
