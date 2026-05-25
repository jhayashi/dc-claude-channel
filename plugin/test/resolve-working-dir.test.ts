import { describe, test, expect } from 'bun:test'
import { resolveWorkingDir } from '../bindings'

/**
 * A chat binding's workingDir can point at a directory that later vanishes
 * (most often a temporary git worktree cleaned up after a merge/release).
 * Spawning claude into a missing cwd makes it hang with no output until the
 * 1-hour turn timeout, so the spawn path resolves the dir up front and heals
 * to a known-good fallback when the recorded one is gone.
 */
describe('resolveWorkingDir', () => {
  test('keeps an existing directory unchanged', () => {
    const r = resolveWorkingDir('/repo/plugin', '/fallback', (p) => p === '/repo/plugin')
    expect(r).toEqual({ workingDir: '/repo/plugin', changed: false })
  })

  test('falls back to the cwd when workingDir is unset (brand-new chat)', () => {
    const r = resolveWorkingDir(undefined, '/fallback', () => true)
    expect(r.workingDir).toBe('/fallback')
    expect(r.changed).toBe(true)
    expect(r.healedFrom).toBeUndefined()
  })

  test('heals to the fallback when a set workingDir no longer exists', () => {
    const r = resolveWorkingDir(
      '/repo/.claude/worktrees/gone/plugin',
      '/fallback',
      (p) => p === '/fallback',
    )
    expect(r.workingDir).toBe('/fallback')
    expect(r.changed).toBe(true)
    expect(r.healedFrom).toBe('/repo/.claude/worktrees/gone/plugin')
  })
})
