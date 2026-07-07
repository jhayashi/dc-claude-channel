import { describe, test, expect } from 'bun:test'
import { isPluginCacheVersionPath } from '../bindings'

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
