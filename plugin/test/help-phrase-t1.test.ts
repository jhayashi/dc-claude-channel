import { describe, test, expect } from 'bun:test'
import { HELP_TOPICS } from '../help-content.js'
import { classifySlash } from '../slash-router.js'
import { classifyIntent } from '../nl-intents.js'
import { SLASH_COMMANDS } from '../slash-commands.js'

// #138 T1: every deterministic phrase the help card advertises must
// classify — slash phrases through the router, NL phrases through the
// intent regexes. A red here means the card is teaching users a phrase
// the system doesn't recognize: fix the CONTENT (swap in a phrase from
// the nl-intents test corpus), never loosen a regex to rescue copy.

const t1 = HELP_TOPICS.flatMap(t => t.journeys).filter(j => j.verify?.tier === 't1')
const dispatcherCmds = new Set(
  SLASH_COMMANDS.filter(r => r.source === 'dispatcher')
    .flatMap(r => [r.cmd, ...(r.aliases ?? [])]).map(c => `/${c}`),
)

describe('help-card T1 phrase routing (#138)', () => {
  test('there are t1 journeys (annotation wiring sane)', () => {
    expect(t1.length).toBeGreaterThanOrEqual(5)
  })

  for (const j of t1) {
    test(`${j.id}: every phrase routes as ${j.verify!.expect}`, () => {
      for (const phrase of j.phrases) {
        if (j.verify!.expect === 'slash') {
          if (dispatcherCmds.has(phrase)) continue // intercepted pre-router by server.ts
          const parsed = classifySlash(phrase)
          expect(parsed, `${phrase} must classify`).not.toBeNull()
          expect(parsed!.kind === 'unknown-slash' ? `UNKNOWN:${phrase}` : 'ok').toBe('ok')
        } else {
          const wanted = j.verify!.expect.slice('nl:'.length)
          const intent = classifyIntent(phrase)
          expect(intent, `${phrase} must match an NL intent`).not.toBeNull()
          // Intent's discriminant field is `kind` (plugin/nl-intents.ts).
          expect(intent!.kind).toBe(wanted)
        }
      }
    })
  }
})
