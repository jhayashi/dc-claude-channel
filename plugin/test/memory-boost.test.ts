import { describe, test, expect } from 'bun:test'
import { memoryBoostEnabled, setMemoryBoost, classifyMemoryBoost, MEMORY_BOOST_META_KEY } from '../agents'
import type { AgentDef } from '../agents'

const def = (over: Partial<AgentDef> = {}): AgentDef => ({ name: 'a', body: '', ...over } as AgentDef)

describe('memory-boost frontmatter', () => {
  test('unset → false (pre-existing agents stay off)', () => {
    expect(memoryBoostEnabled(def())).toBe(false)
  })
  test('explicit on → true, off → false', () => {
    expect(memoryBoostEnabled(def({ [MEMORY_BOOST_META_KEY]: 'on' } as Partial<AgentDef>))).toBe(true)
    expect(memoryBoostEnabled(def({ [MEMORY_BOOST_META_KEY]: 'off' } as Partial<AgentDef>))).toBe(false)
  })
  test('setMemoryBoost writes the key explicitly (on and off)', () => {
    const d = def()
    setMemoryBoost(d, 'on'); expect(d[MEMORY_BOOST_META_KEY]).toBe('on')
    setMemoryBoost(d, 'off'); expect(d[MEMORY_BOOST_META_KEY]).toBe('off')
  })
})

describe('classifyMemoryBoost (creation-time, word-boundary)', () => {
  test('coding-oriented prompt → off', () => {
    expect(classifyMemoryBoost('You are a senior engineer. Edit files, run tests, fix issues in the repo.')).toBe('off')
  })
  test('conversational prompt → on', () => {
    expect(classifyMemoryBoost('A warm companion who chats about your day and remembers what matters.')).toBe('on')
  })
  test('no substring false positives (therapist must not match "api")', () => {
    expect(classifyMemoryBoost('A warm therapist who remembers your week.')).toBe('on')
  })
  test('empty → off (conservative)', () => {
    expect(classifyMemoryBoost('')).toBe('off')
  })
})
