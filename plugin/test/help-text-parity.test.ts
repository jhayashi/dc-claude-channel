import { describe, test, expect } from 'bun:test'
import { HELP_TEXT } from '../slash-handler.js'
import { SLASH_COMMANDS, BLOCKED_COMMANDS, buildHelpText } from '../slash-commands.js'
import { classifySlash, type SlashCommand } from '../slash-router.js'

// #136 → #108 increment 1: the structured SLASH_COMMANDS table is the single
// source of truth. HELP_TEXT is GENERATED from it, and the help card's
// Commands topic will consume the same table — so these tests pin the
// triangle: table ↔ router ↔ rendered text. Drift in any leg fails here.

describe('SLASH_COMMANDS table ↔ router', () => {
  test('every router-sourced command (and alias) classifies to a real kind', () => {
    for (const row of SLASH_COMMANDS.filter(r => r.source === 'router')) {
      for (const cmd of [row.cmd, ...(row.aliases ?? [])]) {
        const parsed = classifySlash(`/${cmd}`)
        expect(parsed, `/${cmd} must classify`).not.toBeNull()
        expect(
          parsed!.kind === 'unknown-slash' || parsed!.kind === 'blocked' ? `BAD:/${cmd}→${parsed!.kind}` : 'ok',
        ).toBe('ok')
      }
    }
  })

  test('aliases classify to the same kind as their primary', () => {
    for (const row of SLASH_COMMANDS.filter(r => r.source === 'router' && r.aliases?.length)) {
      const primary = classifySlash(`/${row.cmd}`)!
      for (const alias of row.aliases!) {
        expect(classifySlash(`/${alias}`)!.kind).toBe(primary.kind)
      }
    }
  })

  test('dispatcher-sourced commands do NOT collide with router commands', () => {
    // /tour etc. are intercepted in server.ts BEFORE the classifier; if the
    // router ever learns one of these names, the dispatcher intercept wins
    // and the router case is dead code — flag it.
    for (const row of SLASH_COMMANDS.filter(r => r.source === 'dispatcher')) {
      for (const cmd of [row.cmd, ...(row.aliases ?? [])]) {
        expect(classifySlash(`/${cmd}`)!.kind).toBe('unknown-slash')
      }
    }
  })

  test('every router kind is documented in the table', () => {
    // Exhaustive over the union (minus meta kinds): adding a SlashCommand
    // kind without a table row is a type error here, and the value names
    // the table cmd that must exist.
    const coverage: Record<Exclude<SlashCommand['kind'], 'blocked' | 'unknown-slash'>, string> = {
      help: 'help',
      stop: 'stop',
      clear: 'clear',
      memory: 'memory',
      mcp: 'mcp',
      plugin: 'plugin',
      model: 'model',
      effort: 'effort',
      compact: 'compact',
      usage: 'usage',
      think: 'think',
      ultrathink: 'ultrathink',
      plan: 'plan',
      'exit-plan': 'exit-plan',
    }
    const tableCmds = new Set(SLASH_COMMANDS.map(r => r.cmd))
    for (const cmd of Object.values(coverage)) {
      expect(tableCmds.has(cmd), `table must document /${cmd}`).toBe(true)
    }
  })

  test('blocked commands classify as blocked', () => {
    for (const cmd of BLOCKED_COMMANDS) {
      expect(classifySlash(`/${cmd}`)!.kind).toBe('blocked')
    }
  })
})

describe('HELP_TEXT generation', () => {
  test('HELP_TEXT is the generated text', () => {
    expect(HELP_TEXT).toBe(buildHelpText())
  })

  test('every table command and alias appears', () => {
    for (const row of SLASH_COMMANDS) {
      expect(HELP_TEXT).toContain(`/${row.cmd}`)
      for (const alias of row.aliases ?? []) {
        expect(HELP_TEXT).toContain(`/${alias}`)
      }
    }
  })

  test('the terminal-only blocked set is listed', () => {
    for (const cmd of BLOCKED_COMMANDS) {
      expect(HELP_TEXT).toContain(`/${cmd}`)
    }
    expect(HELP_TEXT.toLowerCase()).toContain('terminal')
  })

  test('every /token in the text is a table command, alias, or blocked command', () => {
    const known = new Set<string>(['/commands']) // prose token in the footer
    for (const row of SLASH_COMMANDS) {
      known.add(`/${row.cmd}`)
      for (const a of row.aliases ?? []) known.add(`/${a}`)
    }
    for (const b of BLOCKED_COMMANDS) known.add(`/${b}`)
    const tokens = [...new Set(HELP_TEXT.match(/\/[a-z][a-z0-9-]*/g) ?? [])]
    expect(tokens.length).toBeGreaterThan(10)
    for (const tok of tokens) {
      expect(known.has(tok) ? 'known' : `UNKNOWN:${tok}`).toBe('known')
    }
  })
})
