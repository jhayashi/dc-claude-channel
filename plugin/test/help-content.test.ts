import { describe, test, expect } from 'bun:test'
import { HELP_TOPICS } from '../help-content.js'
import { classifySlash } from '../slash-router.js'
import { SLASH_COMMANDS } from '../slash-commands.js'

// #108: content lint — the help card must never over-promise. These rules
// come from the design doc §5.

const allJourneys = HELP_TOPICS.flatMap(t => t.journeys.map(j => ({ topic: t.id, ...j })))

describe('help content lint (#108)', () => {
  test('eight topics, every topic has journeys and a glyph', () => {
    expect(HELP_TOPICS.length).toBe(8)
    for (const t of HELP_TOPICS) {
      expect(t.journeys.length).toBeGreaterThan(0)
      expect(t.glyph.length).toBeGreaterThan(0)
      expect(t.journeys.length, `topic ${t.id} exceeds 8-journey budget`).toBeLessThanOrEqual(20)
    }
  })

  test('journey ids are globally unique (deep-link anchors)', () => {
    const ids = allJourneys.map(j => j.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('every journey has a body; quirks stay footnote-sized', () => {
    for (const j of allJourneys) {
      // Generated command entries carry the table's one-line blurb — short
      // is correct there. Authored entries owe the reader 2–3 sentences.
      const minBody = j.topic === 'commands' ? 12 : 40
      expect(j.body.length, `journey ${j.id} needs a body`).toBeGreaterThan(minBody)
      if (j.quirk) {
        expect(j.quirk.length, `quirk on ${j.id} too long`).toBeLessThanOrEqual(140)
      }
    }
  })

  test('every slash phrase classifies to a real router kind or dispatcher special', () => {
    const dispatcherCmds = new Set(
      SLASH_COMMANDS.filter(r => r.source === 'dispatcher')
        .flatMap(r => [r.cmd, ...(r.aliases ?? [])])
        .map(c => `/${c}`),
    )
    for (const j of allJourneys.filter(j => j.slash)) {
      for (const p of j.phrases) {
        if (dispatcherCmds.has(p)) continue
        const parsed = classifySlash(p)
        expect(parsed, `${p} on ${j.id} must classify`).not.toBeNull()
        expect(
          parsed!.kind === 'unknown-slash' ? `UNKNOWN:${p}` : 'ok',
          `${p} on ${j.id}`,
        ).toBe('ok')
      }
    }
  })

  test('placeholder phrases explain the fill-in', () => {
    for (const j of allJourneys) {
      const hasPlaceholder = j.phrases.some(p => /<[^>]+>/.test(p))
      if (hasPlaceholder) {
        expect(
          /fill in|swap|replace|with one of|whatever/i.test(j.body),
          `journey ${j.id} has a <placeholder> phrase but its body doesn't explain filling it in`,
        ).toBe(true)
      }
    }
  })

  test('the Commands topic covers every SLASH_COMMANDS row', () => {
    const commands = HELP_TOPICS.find(t => t.id === 'commands')!
    for (const row of SLASH_COMMANDS) {
      expect(
        commands.journeys.some(j => j.title.startsWith(`/${row.cmd}`)),
        `Commands topic missing /${row.cmd}`,
      ).toBe(true)
    }
  })

  test('content serializes to a reasonable payload for HTML injection', () => {
    const json = JSON.stringify(HELP_TOPICS)
    expect(json.length).toBeLessThan(40_000)
    // must survive an HTML <script> context: no closing-tag sequence
    expect(json).not.toContain('</script')
  })
})
