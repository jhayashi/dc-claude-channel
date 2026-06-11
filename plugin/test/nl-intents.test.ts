import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyIntent, shouldClassify } from '../nl-intents.js'

describe('NL intent classifier — positive cases', () => {
  test.each([
    ['switch to sonnet', { kind: 'model-switch', tier: 'sonnet' }],
    ['use opus please', { kind: 'model-switch', tier: 'opus' }],
    ['can you downgrade to haiku', { kind: 'model-switch', tier: 'haiku' }],
    // Broadened (Joe smoke-test feedback): natural model-switch phrasings
    // that previously fell through to the subagent and got hallucinated.
    ['switch model to opus', { kind: 'model-switch', tier: 'opus' }],
    ['switch the model to opus', { kind: 'model-switch', tier: 'opus' }],
    ['change tier to haiku', { kind: 'model-switch', tier: 'haiku' }],
    ["let's switch to opus", { kind: 'model-switch', tier: 'opus' }],
    ["let's use opus", { kind: 'model-switch', tier: 'opus' }],
    ['I want to use sonnet', { kind: 'model-switch', tier: 'sonnet' }],
    ['we should use opus', { kind: 'model-switch', tier: 'opus' }],
    ['go ahead and run sonnet', { kind: 'model-switch', tier: 'sonnet' }],
    ['I want haiku', { kind: 'model-switch', tier: 'haiku' }],
    ['give me opus', { kind: 'model-switch', tier: 'opus' }],
    ['make it sonnet', { kind: 'model-switch', tier: 'sonnet' }],
    ["let's go with opus", { kind: 'model-switch', tier: 'opus' }],
    ['I prefer haiku', { kind: 'model-switch', tier: 'haiku' }],
    ['trust me', { kind: 'trust-toggle', value: true }],
    ['turn on trust', { kind: 'trust-toggle', value: true }],
    ['skip permissions', { kind: 'trust-toggle', value: true }],
    // Broadened trust phrasings.
    ['trust this agent', { kind: 'trust-toggle', value: true }],
    ['trust this chat', { kind: 'trust-toggle', value: true }],
    ['I trust this', { kind: 'trust-toggle', value: true }],
    ['be safer', { kind: 'trust-toggle', value: false }],
    ['turn off trust', { kind: 'trust-toggle', value: false }],
    ['ask before tools', { kind: 'trust-toggle', value: false }],
    ['untrust this agent', { kind: 'trust-toggle', value: false }],
    ["I don't trust you", { kind: 'trust-toggle', value: false }],
    ['stop trusting yourself', { kind: 'trust-toggle', value: false }],
    ["let's refine you", { kind: 'refine' }],
    ['I want to tweak your prompt', { kind: 'refine' }],
    ['be sharper on the math', { kind: 'refine' }],
  ])('classifies %s', (input, expected) => {
    const got = classifyIntent(input)
    expect(got).toMatchObject(expected as object)
  })
})

describe('NL intent classifier — negative corpus', () => {
  test.each([
    'I read a haiku about mountains today',
    'Sonnet 14 from Shakespeare is my favorite',
    'The opus number is unclear',
    'They said "trust me" and walked off',
    'Building trust with my team is hard',
    'I lost trust in the brand after the recall',
    'I want to tweak the recipe',
    'tweak the salt level next time',
    'Let me refine my resume before sending',
    'I need to sharpen my chef knife',
    'Be more careful with the dosage',
    'My friend said "let\'s go" so we left',
    'permissions on the file are wrong',
    'the model car I built',
    'the tax model my accountant uses',
    'I switched majors in college',
    'switch hands when you tire',
    'The downgrade in service is concerning',
    'we use claude haiku for fast tasks',
    'sonnet writing is a discipline',
    'the haiku I wrote yesterday',
    'show me a haiku',
    'why are sonnets fourteen lines',
    'what is opus magnum',
    'the trust fund pays out monthly',
    'enable trust between siblings',
    'trust your gut on this one',
    'Claude Opus 4.7 is the latest model',
    'I quote: "trust me, switch to opus" — that\'s what they said',
    'let\'s tweak the budget projection',
    'sharper picture quality on this monitor',
    // Defenses against the broadened regexes (Joe smoke-test feedback).
    'I want to write a haiku',                  // not "use/run/prefer haiku"
    'we use claude haiku for fast tasks',       // declarative "we use" not in prefix list
    'I read a haiku about mountains today',     // "I read" not a preference verb
    'make a haiku for me',                      // "make a" ≠ "make it/this"
    "let's go with the team to the meeting",    // "let's go with the" but no tier
    'I trust her judgment',                     // "I trust her" not "you/this/it"
    'building trust takes time',                // bare "trust" with no anchor verb
  ])('negative: "%s" returns null', (input) => {
    expect(classifyIntent(input)).toBeNull()
  })

  test('returns null for unrelated text', () => {
    expect(classifyIntent('what is the capital of france?')).toBeNull()
    expect(classifyIntent('thanks!')).toBeNull()
  })
})

describe('NL intent classifier — precedence', () => {
  test('trust phrasing wins over model phrasing', () => {
    // "trust me, switch to opus" — both regexes plausibly match.
    // Resolve to trust-toggle first so the user can issue model-switch separately.
    const got = classifyIntent('trust me, switch to opus')
    expect(got?.kind).toBe('trust-toggle')
  })

  test('model-switch wins over refine when explicit', () => {
    expect(classifyIntent('switch to haiku and refine your tone')?.kind).toBe('model-switch')
  })

  test('does not classify phrases inside quotes', () => {
    expect(classifyIntent('They said "trust me" and walked off')).toBeNull()
    expect(classifyIntent('The button said "switch to opus"')).toBeNull()
  })
})

describe('shouldClassify gate', () => {
  test('returns false when chat has an active coach session', () => {
    const fakeSessions = new Map<number, unknown>()
    fakeSessions.set(42, { coachState: { remaining: [] } })
    expect(shouldClassify(42, fakeSessions)).toBe(false)
  })

  test('returns true when chat has no coach session', () => {
    const fakeSessions = new Map<number, unknown>()
    expect(shouldClassify(43, fakeSessions)).toBe(true)
  })
})

// v1.4.11 — NL switch tier alphabet derived from MODELS at runtime so
// adding a tier to plugin/models.json automatically enables NL switching.
// Custom IDs typed via the agent-setup picker do NOT get NL switching
// (curated vs power-user split).
describe('NL intent classifier — v1.4.11 manifest-derived tier alphabet', () => {
  test('does not classify "switch to fable" (fable not in manifest)', () => {
    expect(classifyIntent('switch to fable')).toBeNull()
    expect(classifyIntent('use fable')).toBeNull()
    expect(classifyIntent('I want fable')).toBeNull()
  })

  test('still classifies switch to known manifest tiers', () => {
    expect(classifyIntent('switch to opus')).toEqual({ kind: 'model-switch', tier: 'opus' })
    expect(classifyIntent('use sonnet')).toEqual({ kind: 'model-switch', tier: 'sonnet' })
    expect(classifyIntent('I want haiku')).toEqual({ kind: 'model-switch', tier: 'haiku' })
  })

  // Structural regression guard: the regex tier alphabet must be sourced
  // from MODELS at runtime, not hardcoded. If a future edit reintroduces
  // (haiku|sonnet|opus) as a string literal in nl-intents.ts, this test
  // fails so the author has to consciously revert the v1.4.11 mechanism.
  test('source references MODELS.map for tier alphabet (regression guard)', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'nl-intents.ts'), 'utf-8')
    expect(src).toMatch(/MODELS\.map/)
    // The literal "(haiku|sonnet|opus)" must not appear in source after Phase B.
    expect(src).not.toMatch(/\(haiku\|sonnet\|opus\)/)
  })
})
