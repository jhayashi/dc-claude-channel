import { describe, test, expect } from 'bun:test'
import { computeEmoji } from '../dispatcher/activity-reactions'

describe('computeEmoji tool classes', () => {
  test('coding tools → 👨‍💻', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      expect(computeEmoji(tool, {})).toBe('\u{1F468}\u{200D}\u{1F4BB}')
    }
  })

  test('reading tools → 🔍', () => {
    for (const tool of ['Read', 'Grep', 'Glob']) {
      expect(computeEmoji(tool, {})).toBe('\u{1F50D}')
    }
  })

  test('Bash → ⚙️', () => {
    expect(computeEmoji('Bash', { command: 'ls' })).toBe('\u2699\uFE0F')
  })

  test('web tools → 🌐', () => {
    expect(computeEmoji('WebFetch', {})).toBe('\u{1F310}')
    expect(computeEmoji('WebSearch', {})).toBe('\u{1F310}')
  })

  test('ExitPlanMode → ✍️', () => {
    expect(computeEmoji('ExitPlanMode', {})).toBe('\u270D\uFE0F')
  })

  test('Task → 🤝', () => {
    expect(computeEmoji('Task', {})).toBe('\u{1F91D}')
  })

  test('dc_* tools are skipped (noise)', () => {
    expect(computeEmoji('dc_send', {})).toBeNull()
    expect(computeEmoji('dc_send_file', {})).toBeNull()
    expect(computeEmoji('dc_react', {})).toBeNull()
  })

  test('unknown tool returns null', () => {
    expect(computeEmoji('SomeFutureTool', {})).toBeNull()
  })
})
