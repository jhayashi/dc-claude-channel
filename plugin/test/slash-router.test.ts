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
    ['/model opus', { kind: 'model', tier: 'opus' }],
    ['/model sonnet', { kind: 'model', tier: 'sonnet' }],
    ['/model haiku', { kind: 'model', tier: 'haiku' }],
    ['/model OPUS', { kind: 'model', tier: 'opus' }],
    ['/model', { kind: 'model', tier: null }],
    ['/model gpt-4', { kind: 'model', tier: null }],
    ['/compact', { kind: 'compact' }],
    ['/usage', { kind: 'usage' }],
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

describe('classifySlash — returns null for non-slash messages', () => {
  test.each([
    'help',
    'stop the server',
    '//help',
    '/ help',
    '/123invalid',
    '',
    '   ',
    'just a normal message',
    'I want to /help',
  ])('"%s"', (input) => {
    expect(classifySlash(input)).toBeNull()
  })
})

describe('classifySlash — blocked (terminal-only commands)', () => {
  test.each([
    ['/config', 'config'],
    ['/loop', 'loop'],
    ['/schedule', 'schedule'],
    ['/keybindings', 'keybindings'],
    ['/keybindings-help', 'keybindings-help'],
    ['/update-config', 'update-config'],
  ])('%s → blocked', (input, cmd) => {
    expect(classifySlash(input)).toEqual({ kind: 'blocked', cmd })
  })
})

describe('classifySlash — unknown slash (pass-through to subagent)', () => {
  test.each<[string, SlashCommand]>([
    ['/ultrareview', { kind: 'unknown-slash', cmd: 'ultrareview', args: '' }],
    ['/review fix the bug', { kind: 'unknown-slash', cmd: 'review', args: 'fix the bug' }],
    ['/foo', { kind: 'unknown-slash', cmd: 'foo', args: '' }],
    ['/think hard', { kind: 'unknown-slash', cmd: 'think', args: 'hard' }],
  ])('%s', (input, expected) => {
    expect(classifySlash(input)).toEqual(expected)
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
