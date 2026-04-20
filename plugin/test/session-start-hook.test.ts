import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = join(import.meta.dir, '..', 'scripts', 'session-start.sh')

let tmpHome: string
let pluginData: string
let stateDir: string
let approvedDir: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'dc-hook-test-'))
  pluginData = mkdtempSync(join(tmpdir(), 'dc-hook-pdata-'))
  stateDir = join(tmpHome, '.claude', 'channels', 'deltachat')
  approvedDir = join(stateDir, 'approved')
})

afterEach(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
  try { rmSync(pluginData, { recursive: true, force: true }) } catch {}
})

function runHook(): { stdout: string; exitCode: number } {
  const proc = Bun.spawnSync([HOOK], {
    env: { ...process.env, HOME: tmpHome, CLAUDE_PLUGIN_DATA: pluginData },
  })
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? -1 }
}

test('empty state, no welcomed flag → emits inline welcome and creates flag', () => {
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('Greet the user')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('/deltachat:setup')
  expect(existsSync(join(pluginData, '.welcomed'))).toBe(true)
})

test('empty state, welcomed flag exists → emits silent hint, flag still exists', () => {
  writeFileSync(join(pluginData, '.welcomed'), '')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.hookSpecificOutput.additionalContext).toContain('If the user asks about Delta Chat')
  expect(parsed.hookSpecificOutput.additionalContext).not.toContain('Greet the user')
  expect(existsSync(join(pluginData, '.welcomed'))).toBe(true)
})

test('paired chat present → exits 0 with no output', () => {
  mkdirSync(approvedDir, { recursive: true })
  writeFileSync(join(approvedDir, '12345'), '{}')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('state dir missing → behaves as empty (inline welcome)', () => {
  // tmpHome is fresh, no state dir at all
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.hookSpecificOutput.additionalContext).toContain('Greet the user')
})

test('paired then unpaired (file removed) re-triggers silent hint', () => {
  // First paired
  mkdirSync(approvedDir, { recursive: true })
  writeFileSync(join(approvedDir, '12345'), '{}')
  expect(runHook().stdout.trim()).toBe('')
  // Mark as previously welcomed
  writeFileSync(join(pluginData, '.welcomed'), '')
  // Now unpair
  rmSync(join(approvedDir, '12345'))
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.hookSpecificOutput.additionalContext).toContain('If the user asks about Delta Chat')
})
