import { describe, test, expect } from 'bun:test'
import { isPluginCacheVersionPath, resolveSpawnCwd } from '../bindings'

describe('isPluginCacheVersionPath', () => {
  test('matches a plugin-cache version dir (with and without the /plugin subdir)', () => {
    expect(isPluginCacheVersionPath('/home/u/.claude/plugins/cache/dc-claude-channel/deltachat/1.4.5/plugin')).toBe(true)
    expect(isPluginCacheVersionPath('/home/u/.claude/plugins/cache/dc-claude-channel/deltachat/1.4.16')).toBe(true)
  })
  test('matches regardless of marketplace segment', () => {
    expect(isPluginCacheVersionPath('/home/u/.claude/plugins/cache/other-mkt/deltachat/2.0.0')).toBe(true)
  })
  test('does NOT match a dev checkout or an unrelated gone dir', () => {
    expect(isPluginCacheVersionPath('/home/u/src/dc-claude-channel/plugin')).toBe(false)
    expect(isPluginCacheVersionPath('/home/u/.claude/worktrees/gone/plugin')).toBe(false)
    expect(isPluginCacheVersionPath('/home/u/projects/deltachat/foo')).toBe(false)
  })
})

const CUR = '/home/u/.claude/plugins/cache/dc-claude-channel/deltachat/1.4.16/plugin'

describe('resolveSpawnCwd', () => {
  test('kind:ok when the recorded dir exists', () => {
    const r = resolveSpawnCwd('/repo/plugin', {
      fallbackCwd: '/cwd', currentPluginDir: CUR, dirExists: (p) => p === '/repo/plugin',
    })
    expect(r).toEqual({ kind: 'ok', workingDir: '/repo/plugin' })
  })

  test('kind:adopt (fallbackCwd) when no dir is recorded (brand-new chat)', () => {
    const r = resolveSpawnCwd(undefined, {
      fallbackCwd: '/cwd', currentPluginDir: CUR, dirExists: () => true,
    })
    expect(r).toEqual({ kind: 'adopt', workingDir: '/cwd' })
  })

  test('kind:healed to the current plugin dir when a pruned cache-version path is gone', () => {
    const pruned = '/home/u/.claude/plugins/cache/dc-claude-channel/deltachat/1.4.5/plugin'
    const r = resolveSpawnCwd(pruned, {
      fallbackCwd: '/cwd', currentPluginDir: CUR,
      dirExists: (p) => p === CUR, // pruned is gone, current exists
    })
    expect(r).toEqual({ kind: 'healed', workingDir: CUR, healedFrom: pruned })
  })

  test('kind:unresolvable when a gone dir is NOT a cache-version path (deleted worktree)', () => {
    const gone = '/home/u/.claude/worktrees/gone/plugin'
    const r = resolveSpawnCwd(gone, {
      fallbackCwd: '/cwd', currentPluginDir: CUR, dirExists: (p) => p === CUR,
    })
    expect(r).toEqual({ kind: 'unresolvable', missingDir: gone })
  })

  test('kind:unresolvable when a pruned cache path is gone AND the current plugin dir is also missing', () => {
    const pruned = '/home/u/.claude/plugins/cache/dc-claude-channel/deltachat/1.4.5/plugin'
    const r = resolveSpawnCwd(pruned, {
      fallbackCwd: '/cwd', currentPluginDir: CUR, dirExists: () => false,
    })
    expect(r).toEqual({ kind: 'unresolvable', missingDir: pruned })
  })
})
