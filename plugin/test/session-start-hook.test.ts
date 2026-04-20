import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOOK = join(import.meta.dir, '..', 'scripts', 'session-start.sh')

let tmpHome: string
let pluginRoot: string
let stateDir: string
let approvedDir: string

function writeInstalled() {
  // Simulate "install is complete": bun.lock newer than package.json.
  writeFileSync(join(pluginRoot, 'package.json'), '{}')
  writeFileSync(join(pluginRoot, 'bun.lock'), '')
  const newer = new Date(Date.now() + 1000)
  utimesSync(join(pluginRoot, 'bun.lock'), newer, newer)
}

function writePending() {
  // Simulate "install pending": bun.lock missing. package.json present.
  writeFileSync(join(pluginRoot, 'package.json'), '{}')
}

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

test('installed + unpaired → unpaired banner', () => {
  writeInstalled()
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).toContain('Delta Chat plugin is ready')
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('no chat is paired')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('/deltachat:setup')
})

test('install pending (missing bun.lock) → install-pending banner', () => {
  writePending()
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).toContain('installing its native dependencies in the background')
  expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart')
  expect(parsed.hookSpecificOutput.additionalContext).toContain('still installing')
})

test('install pending (package.json newer than bun.lock) → install-pending banner', () => {
  writeInstalled()
  // Now make package.json newer than bun.lock to simulate a dep-bump.
  const later = new Date(Date.now() + 2000)
  utimesSync(join(pluginRoot, 'package.json'), later, later)
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).toContain('installing its native dependencies in the background')
})

test('paired chat present → exits 0 with no output', () => {
  writeInstalled()
  mkdirSync(approvedDir, { recursive: true })
  writeFileSync(join(approvedDir, '12345'), '{}')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('')
})

test('install-pending beats unpaired — banner priority', () => {
  // Even with paired chats, if deps look broken we show the install banner.
  // Actually: the hook prioritizes install-pending over paired check, which
  // is intentional because without deps no DC activity can happen.
  writePending()
  mkdirSync(approvedDir, { recursive: true })
  writeFileSync(join(approvedDir, '12345'), '{}')
  const { stdout, exitCode } = runHook()
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout)
  expect(parsed.systemMessage).toContain('installing its native dependencies')
})
