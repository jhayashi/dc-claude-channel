import { describe, test, expect } from 'bun:test'
import {
  computeEmoji,
  todoStepEmoji,
  createActivityReactor,
} from '../dispatcher/activity-reactions'

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

describe('todoStepEmoji', () => {
  test('null / non-object input → null', () => {
    expect(todoStepEmoji(null)).toBeNull()
    expect(todoStepEmoji(undefined)).toBeNull()
    expect(todoStepEmoji('nope')).toBeNull()
    expect(todoStepEmoji(42)).toBeNull()
  })

  test('missing todos array → null', () => {
    expect(todoStepEmoji({})).toBeNull()
    expect(todoStepEmoji({ todos: 'not an array' })).toBeNull()
  })

  test('no in_progress todo → null', () => {
    const todos = [
      { status: 'completed', content: 'a' },
      { status: 'pending', content: 'b' },
    ]
    expect(todoStepEmoji({ todos })).toBeNull()
  })

  test('first in_progress at index 0 → 1️⃣', () => {
    const todos = [{ status: 'in_progress', content: 'a' }]
    expect(todoStepEmoji({ todos })).toBe('1\uFE0F\u20E3')
  })

  test('in_progress at index 5 → 6️⃣', () => {
    const todos = [
      { status: 'completed' }, { status: 'completed' },
      { status: 'completed' }, { status: 'completed' },
      { status: 'completed' }, { status: 'in_progress' },
    ]
    expect(todoStepEmoji({ todos })).toBe('6\uFE0F\u20E3')
  })

  test('in_progress at index 8 → 9️⃣', () => {
    const todos = Array.from({ length: 9 }, (_, i) => ({
      status: i === 8 ? 'in_progress' : 'completed',
    }))
    expect(todoStepEmoji({ todos })).toBe('9\uFE0F\u20E3')
  })

  test('in_progress at index 9 → 🇦 (regional indicator A)', () => {
    const todos = Array.from({ length: 10 }, (_, i) => ({
      status: i === 9 ? 'in_progress' : 'completed',
    }))
    expect(todoStepEmoji({ todos })).toBe('\u{1F1E6}')
  })

  test('in_progress at index 34 → 🇿 (regional indicator Z)', () => {
    const todos = Array.from({ length: 35 }, (_, i) => ({
      status: i === 34 ? 'in_progress' : 'completed',
    }))
    expect(todoStepEmoji({ todos })).toBe('\u{1F1FF}')
  })

  test('in_progress at index 35 → null (out of range)', () => {
    const todos = Array.from({ length: 36 }, (_, i) => ({
      status: i === 35 ? 'in_progress' : 'completed',
    }))
    expect(todoStepEmoji({ todos })).toBeNull()
  })

  test('picks FIRST in_progress when multiple exist', () => {
    const todos = [
      { status: 'in_progress', content: 'first' },
      { status: 'in_progress', content: 'second' },
    ]
    expect(todoStepEmoji({ todos })).toBe('1\uFE0F\u20E3')
  })
})

function makeReactor() {
  const calls: Array<{ msgId: number; emoji: string }> = []
  const logs: string[] = []
  const reactor = createActivityReactor({
    sendReaction: async (msgId, emoji) => {
      calls.push({ msgId, emoji })
    },
    logf: (fmt, ...args) => {
      logs.push(`${fmt} ${JSON.stringify(args)}`)
    },
  })
  return { reactor, calls, logs }
}

describe('createActivityReactor', () => {
  test('no-op when no turn target is set', async () => {
    const { reactor, calls } = makeReactor()
    reactor.reactForTool(1, 'Bash', {})
    // Give the fire-and-forget promise a tick.
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([])
  })

  test('fires reaction for a set turn target', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.reactForTool(1, 'Bash', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ msgId: 100, emoji: '\u2699\uFE0F' }])
  })

  test('debounces repeated same emoji', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.reactForTool(1, 'Read', {})
    reactor.reactForTool(1, 'Grep', {})
    reactor.reactForTool(1, 'Glob', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ msgId: 100, emoji: '\u{1F50D}' }])
  })

  test('fires again when emoji class changes', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.reactForTool(1, 'Read', {})
    reactor.reactForTool(1, 'Bash', {})
    reactor.reactForTool(1, 'Edit', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([
      { msgId: 100, emoji: '\u{1F50D}' },
      { msgId: 100, emoji: '\u2699\uFE0F' },
      { msgId: 100, emoji: '\u{1F468}\u{200D}\u{1F4BB}' },
    ])
  })

  test('skips unknown tools without disturbing debounce state', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.reactForTool(1, 'Read', {})
    reactor.reactForTool(1, 'dc_send', {})   // skipped
    reactor.reactForTool(1, 'Unknown', {})   // skipped
    reactor.reactForTool(1, 'Grep', {})      // debounced (still 🔍)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ msgId: 100, emoji: '\u{1F50D}' }])
  })

  test('clearTurnTarget drops state so subsequent calls no-op', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.reactForTool(1, 'Bash', {})
    reactor.clearTurnTarget(1)
    reactor.reactForTool(1, 'Edit', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([{ msgId: 100, emoji: '\u2699\uFE0F' }])
  })

  test('setTurnTarget on the same chat resets debounce and target', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.reactForTool(1, 'Bash', {})
    reactor.setTurnTarget(1, 200)
    reactor.reactForTool(1, 'Bash', {})  // new turn → fires again
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([
      { msgId: 100, emoji: '\u2699\uFE0F' },
      { msgId: 200, emoji: '\u2699\uFE0F' },
    ])
  })

  test('chats are isolated', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.setTurnTarget(2, 200)
    reactor.reactForTool(1, 'Read', {})
    reactor.reactForTool(2, 'Bash', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([
      { msgId: 100, emoji: '\u{1F50D}' },
      { msgId: 200, emoji: '\u2699\uFE0F' },
    ])
  })

  test('swallows sendReaction failures silently', async () => {
    const reactor = createActivityReactor({
      sendReaction: async () => { throw new Error('boom') },
    })
    reactor.setTurnTarget(1, 100)
    expect(() => reactor.reactForTool(1, 'Bash', {})).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
