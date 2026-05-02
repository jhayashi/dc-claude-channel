import { describe, test, expect } from 'bun:test'
import { classifySlash, shouldClassifySlash, type SlashCommand } from '../slash-router.js'

describe('classifySlash — recognised commands', () => {
  test.each<[string, SlashCommand]>([
    ['/help', { kind: 'help' }],
    ['/HELP', { kind: 'help' }],
    ['/Help', { kind: 'help' }],
    ['/stop', { kind: 'stop' }],
    ['/STOP', { kind: 'stop' }],
    ['/clear', { kind: 'clear' }],
    ['/mcp', { kind: 'mcp' }],
    ['/MCP', { kind: 'mcp' }],
    ['/plugin', { kind: 'plugin' }],
    ['/plugins', { kind: 'plugin' }],
    ['/memory', { kind: 'memory' }],
    ['/memory show feedback_haiku', { kind: 'memory', subcommand: 'show', key: 'feedback_haiku' }],
    ['/memory show feedback_haiku extra', { kind: 'memory', subcommand: 'show', key: 'feedback_haiku' }],
    ['/memory feedback_haiku', { kind: 'memory', subcommand: 'show', key: 'feedback_haiku' }],
  ])('%s', (input, expected) => {
    expect(classifySlash(input)).toEqual(expected)
  })
})

describe('classifySlash — leading/trailing whitespace', () => {
  test.each([
    '  /help  ',
    '\t/stop\n',
    '  /clear',
  ])('"%s" is trimmed before match', (input) => {
    expect(classifySlash(input)).not.toBeNull()
  })
})

describe('classifySlash — returns null for non-slashes', () => {
  test.each([
    'help',
    'stop the server',
    '//help',
    '/ help',
    '/unknown-command',
    '/123invalid',
    '',
    '   ',
    'just a normal message',
    'I want to /help',
  ])('"%s"', (input) => {
    expect(classifySlash(input)).toBeNull()
  })
})

describe('classifySlash — slash passthrough (sent to subagent unchanged)', () => {
  test.each([
    '/schedule',
    '/loop',
    '/ultrareview',
    '/think',
    '/foo',
  ])('%s is not a recognised slash', (input) => {
    expect(classifySlash(input)).toBeNull()
  })
})

describe('shouldClassifySlash', () => {
  test('returns true when chat is not in appSessions', () => {
    const sessions = new Map<number, unknown>()
    expect(shouldClassifySlash(42, sessions)).toBe(true)
  })

  test('returns false when chat is in coach-mode (appSessions)', () => {
    const sessions = new Map<number, unknown>([[42, {}]])
    expect(shouldClassifySlash(42, sessions)).toBe(false)
  })

  test('only blocks the specific chatId in sessions', () => {
    const sessions = new Map<number, unknown>([[42, {}]])
    expect(shouldClassifySlash(99, sessions)).toBe(true)
  })
})
