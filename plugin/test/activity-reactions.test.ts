import { describe, test, expect } from 'bun:test'
import {
  computeEmoji,
  todoStepEmoji,
  createActivityReactor,
  THINKING_EMOJIS,
  CODING_EMOJIS,
  RUNNING_EMOJIS,
  READING_EMOJIS,
  PLANNING_EMOJIS,
} from '../dispatcher/activity-reactions'

const codingSet = new Set(CODING_EMOJIS)
const runningSet = new Set(RUNNING_EMOJIS)
const readingSet = new Set(READING_EMOJIS)
const planningSet = new Set(PLANNING_EMOJIS)

describe('computeEmoji tool classes', () => {
  test('coding tools → coding class, random from coding pool', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
      const r = computeEmoji(tool, {})!
      expect(r.cls).toBe('coding')
      expect(codingSet.has(r.emoji)).toBe(true)
    }
  })

  test('reading tools → reading class, random from reading pool', () => {
    for (const tool of ['Read', 'Grep', 'Glob', 'LS']) {
      const r = computeEmoji(tool, {})!
      expect(r.cls).toBe('reading')
      expect(readingSet.has(r.emoji)).toBe(true)
    }
  })

  test('Bash → running class, random from running pool', () => {
    const r = computeEmoji('Bash', { command: 'ls' })!
    expect(r.cls).toBe('running')
    expect(runningSet.has(r.emoji)).toBe(true)
  })

  test('web tools → 🌐', () => {
    expect(computeEmoji('WebFetch', {})).toEqual({ cls: 'web', emoji: '\u{1F310}' })
    expect(computeEmoji('WebSearch', {})).toEqual({ cls: 'web', emoji: '\u{1F310}' })
  })

  test('EnterPlanMode / ExitPlanMode → planning class, random from planning pool', () => {
    const r1 = computeEmoji('EnterPlanMode', {})!
    const r2 = computeEmoji('ExitPlanMode', {})!
    expect(r1.cls).toBe('planning')
    expect(planningSet.has(r1.emoji)).toBe(true)
    expect(r2.cls).toBe('planning')
    expect(planningSet.has(r2.emoji)).toBe(true)
  })

  test('Agent / Task → 🤝', () => {
    expect(computeEmoji('Agent', {})).toEqual({ cls: 'delegating', emoji: '\u{1F91D}' })
    expect(computeEmoji('Task', {})).toEqual({ cls: 'delegating', emoji: '\u{1F91D}' })
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
  const clock = { t: 0 }
  const reactor = createActivityReactor({
    sendReaction: async (msgId, emoji) => {
      calls.push({ msgId, emoji })
    },
    now: () => clock.t,
    logf: (fmt, ...args) => {
      logs.push(`${fmt} ${JSON.stringify(args)}`)
    },
  })
  return { reactor, calls, logs, clock }
}

describe('createActivityReactor', () => {
  test('no-op when no turn target is set', async () => {
    const { reactor, calls } = makeReactor()
    reactor.reactForTool(1, 'Bash', {})
    // Give the fire-and-forget promise a tick.
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toEqual([])
  })

  const thinkingSet = new Set(THINKING_EMOJIS)
  function isThinking(emoji: string) { return thinkingSet.has(emoji) }

  test('setTurnTarget emits immediate thinking indicator', async () => {
    const { reactor, calls } = makeReactor()
    reactor.setTurnTarget(1, 100)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(1)
    expect(calls[0].msgId).toBe(100)
    expect(isThinking(calls[0].emoji)).toBe(true)
  })

  test('fires reaction for a set turn target after debounce window', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    clock.t += 60_000
    reactor.reactForTool(1, 'Bash', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(2)
    expect(isThinking(calls[0].emoji)).toBe(true)
    expect(calls[1].msgId).toBe(100)
    expect(runningSet.has(calls[1].emoji)).toBe(true)
  })

  test('debounces tool reactions within 60s of last fire', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    clock.t += 30_000  // halfway through debounce window
    reactor.reactForTool(1, 'Bash', {})
    reactor.reactForTool(1, 'Edit', {})
    reactor.reactForTool(1, 'Read', {})
    await new Promise((r) => setTimeout(r, 0))
    // Only the thinking emoji from setTurnTarget fired.
    expect(calls).toHaveLength(1)
    expect(isThinking(calls[0].emoji)).toBe(true)
  })

  test('debounces repeated same class', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    clock.t += 60_000
    reactor.reactForTool(1, 'Read', {})
    reactor.reactForTool(1, 'Grep', {})
    reactor.reactForTool(1, 'Glob', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(2)
    expect(isThinking(calls[0].emoji)).toBe(true)
    expect(calls[1].msgId).toBe(100); expect(readingSet.has(calls[1].emoji)).toBe(true)
  })

  test('class changes still rate-limited to one fire per 60s', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    clock.t += 60_000
    reactor.reactForTool(1, 'Read', {})   // fires 🔍
    clock.t += 60_000
    reactor.reactForTool(1, 'Bash', {})   // fires running emoji
    clock.t += 60_000
    reactor.reactForTool(1, 'Edit', {})   // fires coding emoji
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(4)
    expect(isThinking(calls[0].emoji)).toBe(true)
    expect(readingSet.has(calls[1].emoji)).toBe(true)
    expect(runningSet.has(calls[2].emoji)).toBe(true)
    expect(codingSet.has(calls[3].emoji)).toBe(true)
  })

  test('skips unknown tools without disturbing debounce state', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    clock.t += 60_000
    reactor.reactForTool(1, 'Read', {})
    reactor.reactForTool(1, 'dc_send', {})   // skipped
    reactor.reactForTool(1, 'Unknown', {})   // skipped
    reactor.reactForTool(1, 'Grep', {})      // class debounced (still 🔍)
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(2)
    expect(isThinking(calls[0].emoji)).toBe(true)
    expect(calls[1].msgId).toBe(100); expect(readingSet.has(calls[1].emoji)).toBe(true)
  })

  test('clearTurnTarget drops state so subsequent calls no-op', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    clock.t += 60_000
    reactor.reactForTool(1, 'Bash', {})
    reactor.clearTurnTarget(1)
    clock.t += 60_000
    reactor.reactForTool(1, 'Edit', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(2)
    expect(isThinking(calls[0].emoji)).toBe(true)
    expect(calls[1].msgId).toBe(100)
    expect(runningSet.has(calls[1].emoji)).toBe(true)
  })

  test('setTurnTarget on the same chat resets debounce and target', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    clock.t += 60_000
    reactor.reactForTool(1, 'Bash', {})
    reactor.setTurnTarget(1, 200)        // new turn fires thinking immediately
    clock.t += 60_000
    reactor.reactForTool(1, 'Bash', {})  // new turn → fires again
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(4)
    expect(isThinking(calls[0].emoji)).toBe(true)
    expect(calls[0].msgId).toBe(100)
    expect(calls[1].msgId).toBe(100)
    expect(runningSet.has(calls[1].emoji)).toBe(true)
    expect(isThinking(calls[2].emoji)).toBe(true)
    expect(calls[2].msgId).toBe(200)
    expect(calls[3].msgId).toBe(200)
    expect(runningSet.has(calls[3].emoji)).toBe(true)
  })

  test('chats are isolated', async () => {
    const { reactor, calls, clock } = makeReactor()
    reactor.setTurnTarget(1, 100)
    reactor.setTurnTarget(2, 200)
    clock.t += 60_000
    reactor.reactForTool(1, 'Read', {})
    reactor.reactForTool(2, 'Bash', {})
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toHaveLength(4)
    expect(isThinking(calls[0].emoji)).toBe(true)
    expect(calls[0].msgId).toBe(100)
    expect(isThinking(calls[1].emoji)).toBe(true)
    expect(calls[1].msgId).toBe(200)
    expect(calls[2].msgId).toBe(100); expect(readingSet.has(calls[2].emoji)).toBe(true)
    expect(calls[3].msgId).toBe(200)
    expect(runningSet.has(calls[3].emoji)).toBe(true)
  })

  test('swallows sendReaction failures silently', async () => {
    const reactor = createActivityReactor({
      sendReaction: async () => { throw new Error('boom') },
    })
    // setTurnTarget emits thinking reaction — should not throw
    expect(() => reactor.setTurnTarget(1, 100)).not.toThrow()
    expect(() => reactor.reactForTool(1, 'Bash', {})).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
  })
})
