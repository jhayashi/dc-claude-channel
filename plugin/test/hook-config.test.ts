import { describe, it, expect, afterEach } from 'bun:test'
import { readFileSync, rmSync, existsSync } from 'node:fs'
import {
  generateHookConfig,
  DEFAULT_GATED_TOOLS,
} from '../dispatcher/hook-config.js'

describe('generateHookConfig', () => {
  const cleanups: string[] = []
  afterEach(() => {
    for (const dir of cleanups.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('writes a settings.json with the default gated tools', () => {
    const { settingsPath, tempDir } = generateHookConfig({ hookScriptPath: '/tmp/fake-hook.sh' })
    cleanups.push(tempDir)
    expect(existsSync(settingsPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.hooks.PreToolUse).toHaveLength(DEFAULT_GATED_TOOLS.length)
    for (const entry of parsed.hooks.PreToolUse) {
      expect(DEFAULT_GATED_TOOLS).toContain(entry.matcher)
      expect(entry.hooks[0].command).toBe('/tmp/fake-hook.sh')
      expect(entry.hooks[0].type).toBe('command')
    }
  })

  it('respects a custom gatedTools list', () => {
    const { settingsPath, tempDir } = generateHookConfig({
      hookScriptPath: '/tmp/h.sh',
      gatedTools: ['Bash'],
    })
    cleanups.push(tempDir)
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.hooks.PreToolUse).toHaveLength(1)
    expect(parsed.hooks.PreToolUse[0].matcher).toBe('Bash')
  })
})
