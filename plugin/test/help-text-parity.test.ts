import { describe, test, expect } from 'bun:test'
import { HELP_TEXT } from '../slash-handler.js'
import { classifySlash, type SlashCommand } from '../slash-router.js'

// #136: HELP_TEXT had drifted from the router (missing /effort, /cost,
// /plugins, /tour, /export-schedules, the blocked list). These parity
// checks pin the two surfaces together so the drift can't recur — and the
// #108 help card must derive from the same source.

// Every user-invocable router kind must be documented in HELP_TEXT.
// Record<kind, string> is deliberately exhaustive over the union (minus
// the meta kinds): adding a SlashCommand kind without updating this map
// is a type error, and the map value is the /command that must appear.
const HELP_COVERAGE: Record<
  Exclude<SlashCommand['kind'], 'blocked' | 'unknown-slash'>,
  string
> = {
  help: '/help',
  stop: '/stop',
  clear: '/clear',
  memory: '/memory',
  mcp: '/mcp',
  plugin: '/plugin',
  model: '/model',
  effort: '/effort',
  compact: '/compact',
  usage: '/usage',
  think: '/think',
  ultrathink: '/ultrathink',
  plan: '/plan',
  'exit-plan': '/exit-plan',
}

// Dispatcher-special commands intercepted in server.ts before the
// classifier — not router kinds, but real user surface that help must list.
const DISPATCHER_SPECIALS = ['/tour', '/export-schedules']

describe('HELP_TEXT ↔ router parity (#136)', () => {
  test('every router kind is documented', () => {
    for (const cmd of Object.values(HELP_COVERAGE)) {
      expect(HELP_TEXT).toContain(cmd)
    }
  })

  test('dispatcher-special commands are documented', () => {
    for (const cmd of DISPATCHER_SPECIALS) {
      expect(HELP_TEXT).toContain(cmd)
    }
  })

  test('aliases are documented', () => {
    expect(HELP_TEXT).toContain('/cost')
    expect(HELP_TEXT).toContain('/plugins')
  })

  test('the blocked (terminal-only) set is mentioned', () => {
    expect(HELP_TEXT).toContain('/schedule')
    expect(HELP_TEXT.toLowerCase()).toContain('terminal')
  })

  test('every /command token in HELP_TEXT is recognized by the router or dispatcher', () => {
    // The reverse direction: help must never advertise a command the
    // system doesn't know. Extract /word tokens and classify each.
    const tokens = [...new Set(HELP_TEXT.match(/\/[a-z][a-z0-9-]*/g) ?? [])]
    expect(tokens.length).toBeGreaterThan(10)
    for (const tok of tokens) {
      // prose token in the closing line, not a command
      if (tok === '/commands') continue
      if (DISPATCHER_SPECIALS.includes(tok) || tok === '/tutorial' || tok === '/export-schedule') continue
      const cmd = classifySlash(tok)
      expect(cmd).not.toBeNull()
      // 'blocked' is fine (documented as terminal-only); unknown is drift.
      expect(cmd!.kind === 'unknown-slash' ? `UNKNOWN:${tok}` : 'known').toBe('known')
    }
  })
})
