import { describe, test, expect } from 'bun:test'
import { iconFilenameFor } from '../apps/agent-setup-app'

describe('iconFilenameFor', () => {
  test('default variant per model', () => {
    expect(iconFilenameFor('claude-opus-4-6', false, false)).toBe('agent-opus.png')
    expect(iconFilenameFor('claude-sonnet-4-6', false, false)).toBe('agent-sonnet.png')
    expect(iconFilenameFor('claude-haiku-4-5', false, false)).toBe('agent-haiku.png')
  })

  test('skip-permissions variant', () => {
    expect(iconFilenameFor('claude-opus-4-6', true, false)).toBe('agent-opus-skip.png')
    expect(iconFilenameFor('claude-haiku-4-5', true, false)).toBe('agent-haiku-skip.png')
  })

  test('mirror variant', () => {
    expect(iconFilenameFor('claude-sonnet-4-6', false, true)).toBe('agent-sonnet-mirror.png')
  })

  test('skip + mirror combined', () => {
    expect(iconFilenameFor('claude-opus-4-6', true, true)).toBe('agent-opus-skip-mirror.png')
    expect(iconFilenameFor('claude-sonnet-4-6', true, true)).toBe('agent-sonnet-skip-mirror.png')
    expect(iconFilenameFor('claude-haiku-4-5', true, true)).toBe('agent-haiku-skip-mirror.png')
  })

  test('unknown model falls back to sonnet base', () => {
    expect(iconFilenameFor('claude-nonesuch-9', false, false)).toBe('agent-sonnet.png')
    expect(iconFilenameFor('claude-nonesuch-9', true, true)).toBe('agent-sonnet-skip-mirror.png')
  })
})
