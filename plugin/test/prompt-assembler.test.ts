import { describe, test, expect, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { setLeavesDir, type Leaf } from '../leaves.js'
import { assembleSystemPrompt, refineSystemPrompt, type AssembleInputs } from '../prompt-assembler.js'
import { startRefineCoach, advanceCoach, collectAnswers } from '../coach.js'

beforeEach(() => {
  setLeavesDir(join(import.meta.dir, '..', 'leaves'))
})

describe('System-prompt assembler', () => {
  test('assembles a single-leaf Tutor prompt', () => {
    const input: AssembleInputs = {
      leafIds: ['tutor'],
      preset: 'drill-sergeant',
      sliders: { socratic: 'direct' },
      preferences: [
        'When Sam is stuck, push them to discover the answer.',
        'Always require Sam to show their work.',
      ],
      tools: ['gmail'],
      identityPreamble: 'You are an Algebra II tutor for Sam, an 8th grader.',
    }
    const prompt = assembleSystemPrompt(input)
    expect(prompt).toContain('Algebra II tutor for Sam')
    expect(prompt).toContain('Drill Sergeant')
    expect(prompt).toContain('Direct')
    expect(prompt).toContain('push them to discover')
    expect(prompt.toLowerCase()).toContain('always require')
    expect(prompt.toLowerCase()).toContain('gmail')
  })

  test('assembles a mash-up prompt with lead annotation', () => {
    const input: AssembleInputs = {
      leafIds: ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      leadLeafId: 'sleep-coach',
      preset: 'mentor',
      sliders: { patience: 'patient', earnestness: 'earnest' },
      preferences: [
        'Sleep is the bigger pain right now, but stress is what is driving it.',
        'Be honest, but precede hard observations with reflection of what the user shared.',
      ],
      tools: ['oura'],
      identityPreamble:
        'You are a wellness partner who unifies sleep, stress, and mindfulness ' +
        'into one coherent practice. Sleep is the lead lens.',
    }
    const prompt = assembleSystemPrompt(input)
    expect(prompt).toContain('Sleep is the lead lens')
    expect(prompt).toContain('Sleep coach')
    expect(prompt).toContain('Stress-management coach')
    expect(prompt).toContain('Mentor')
    expect(prompt).toContain('Patient')
    expect(prompt).toContain('Earnest')
    expect(prompt).toContain('Sleep is the bigger pain')
  })

  test('appends the medical liability frame for medical-flagged leaves', () => {
    const prompt = assembleSystemPrompt({
      leafIds: ['sleep-coach'],
      preset: 'coach',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'You are a sleep coach.',
    })
    expect(prompt).toContain('not a licensed clinician')
  })

  test('produces five paragraph breaks (six paragraphs counting blank-tail)', () => {
    const prompt = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: ['Be patient with Sam.'],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    const paragraphs = prompt.split(/\n\s*\n/).filter(p => p.trim())
    expect(paragraphs.length).toBe(5)
  })

  test('omits Specific preferences paragraph when none', () => {
    const prompt = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    expect(prompt).not.toContain('Specific preferences')
  })

  test('caps each preference at 500 chars and escapes quotes after truncation', () => {
    // 600-char preference with a " near the truncation boundary
    const longPref = 'A'.repeat(498) + '"' + 'B'.repeat(100)
    const prompt = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: [longPref],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    // Truncate-then-escape: first 500 chars are kept, the embedded "
    // (now at position 498) is escaped to \" — producing 501 chars in
    // the inner string. Critically, the framed wrap closes with a clean ".
    expect(prompt).toContain('A'.repeat(498) + '\\"' + 'B' /* first B kept; rest dropped */)
    // Make sure the trailing 100 'B's were truncated:
    expect(prompt).not.toContain('B'.repeat(50))
  })

  test('escapes backslashes BEFORE quotes (no \\\\" injection escape)', () => {
    // A preference ending in `\` followed by a `"` would, if the quote
    // were escaped first, produce `…\\"` — a model treating the
    // attribution wrap as JSON-ish reads `\\"` as an escaped quote and
    // consumes the closing wrapper. Backslash-first means `\` -> `\\`,
    // then `"` -> `\"`, yielding `…\\\\"\\"` — both literally escaped.
    const tricky = 'pref ending with backslash\\'
    const prompt = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: [tricky],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    // The literal `\` in the preference must appear as `\\` inside the
    // quoted attribution — i.e. the runtime string contains a real
    // double-backslash before the closing wrap.
    expect(prompt).toContain('backslash\\\\"')
  })

  test('throws with descriptive message when any leaf id is unknown', () => {
    expect(() => assembleSystemPrompt({
      leafIds: ['tutor', 'no-such-leaf'],
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })).toThrow(/unknown leaf ids.*no-such-leaf/)
  })

  test('throws when leadLeafId is not in leafIds', () => {
    expect(() => assembleSystemPrompt({
      leafIds: ['tutor', 'language-coach'],
      leadLeafId: 'sleep-coach',  // not in leafIds
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'You are a tutor + language coach mash-up.',
    })).toThrow(/leadLeafId.*sleep-coach.*not in leafIds/)
  })

  test('throws when leadLeafId is set for a single-leaf agent', () => {
    expect(() => assembleSystemPrompt({
      leafIds: ['tutor'],
      leadLeafId: 'tutor',  // meaningless when only 1 leaf
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })).toThrow(/leadLeafId is meaningless for single-leaf/)
  })

  test('accepts leadLeafId when properly in leafIds (mash-up)', () => {
    // Sanity-check the happy path still works after the invariant.
    const prompt = assembleSystemPrompt({
      leafIds: ['sleep-coach', 'stress-management-coach'],
      leadLeafId: 'sleep-coach',
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'Sleep-led wellness mash-up.',
    })
    expect(prompt).toContain('Sleep coach (lead)')
    expect(prompt).toContain('Stress-management coach')
  })
})

describe('refineSystemPrompt — incremental rewrite', () => {
  test('appends Also: clause to an existing Preferences paragraph', () => {
    const existing = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: ['Be patient with Sam.'],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    const refined = refineSystemPrompt(existing, {
      parameters: {},
      preferences: ['be sharper on follow-up questions'],
      tools: [],
    })
    expect(refined).toContain('Be patient with Sam.')
    expect(refined).toContain('Also: "be sharper on follow-up questions"')
    // Identity / Expertise / Scope untouched.
    expect(refined).toContain('You are a tutor.')
    // Still 5 paragraphs (Identity/Expertise/Voice/Preferences/Scope).
    expect(refined.split(/\n\s*\n/).filter(p => p.trim()).length).toBe(5)
  })

  test('inserts a new Preferences paragraph when none exists', () => {
    const existing = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    expect(existing).not.toContain('Specific preferences')
    expect(existing.split(/\n\s*\n/).filter(p => p.trim()).length).toBe(4)

    const refined = refineSystemPrompt(existing, {
      parameters: {},
      preferences: ['use more concrete examples'],
      tools: [],
    })
    expect(refined).toContain('Specific preferences')
    expect(refined).toContain('use more concrete examples')
    // Now 5 paragraphs — Preferences inserted between Voice and Scope.
    const paragraphs = refined.split(/\n\s*\n/).filter(p => p.trim())
    expect(paragraphs.length).toBe(5)
    // Voice should come before Preferences which should come before Scope.
    const voiceIdx = paragraphs.findIndex(p => p.startsWith('How you sound.'))
    const prefIdx = paragraphs.findIndex(p => p.startsWith('Specific preferences'))
    const scopeIdx = paragraphs.findIndex(p => p.startsWith('What is in and out of scope.'))
    expect(voiceIdx).toBeLessThan(prefIdx)
    expect(prefIdx).toBeLessThan(scopeIdx)
  })

  test('returns input unchanged when changes have no preferences', () => {
    const existing = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: ['Be patient with Sam.'],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    const refined = refineSystemPrompt(existing, {
      parameters: {},
      preferences: [],
      tools: [],
    })
    expect(refined).toBe(existing)
  })

  test('caps each new preference at 500 chars and escapes embedded quotes', () => {
    const existing = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: ['Be patient with Sam.'],
      tools: [],
      identityPreamble: 'You are a tutor.',
    })
    const longPref = 'A'.repeat(498) + '"' + 'B'.repeat(100)
    const refined = refineSystemPrompt(existing, {
      parameters: {},
      preferences: [longPref],
      tools: [],
    })
    expect(refined).toContain('A'.repeat(498) + '\\"' + 'B')
    expect(refined).not.toContain('B'.repeat(50))
  })

  test('round-trip: startRefineCoach → advanceCoach → refineSystemPrompt', () => {
    // Integration: build an initial prompt, run a refine coach turn, splice.
    const existing = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      identityPreamble: 'You are a tutor for Sam.',
    })
    let s = startRefineCoach({ agentId: 'sam-tutor', existingPrompt: existing })
    s = advanceCoach(s, 'always show your work explicitly')
    const refined = refineSystemPrompt(existing, collectAnswers(s))
    expect(refined).toContain('You are a tutor for Sam.')
    expect(refined).toContain('always show your work explicitly')
    // Identity preamble preserved exactly.
    expect(refined.split('\n\n')[0]).toBe('You are a tutor for Sam.')
  })
})
