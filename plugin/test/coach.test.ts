import { describe, test, expect, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { setLeavesDir } from '../leaves.js'
import {
  startCoach,
  advanceCoach,
  isCoachDone,
  collectAnswers,
  detectTools,
  type CoachState,
} from '../coach.js'

beforeEach(() => {
  setLeavesDir(join(import.meta.dir, '..', 'leaves'))
})

describe('Coach state machine', () => {
  test('Tutor coach asks for parameter first', () => {
    const s = startCoach({ leafIds: ['tutor'], preset: 'drill-sergeant', sliders: {} })
    expect(s.nextQuestion).toBeTruthy()
    expect(s.nextQuestion!.toLowerCase()).toContain('subject')
    expect(isCoachDone(s)).toBe(false)
  })

  test('skip-the-interview escape works on first user message', () => {
    let s: CoachState = startCoach({ leafIds: ['tutor'], preset: 'mentor', sliders: {} })
    s = advanceCoach(s, "let's go")
    expect(isCoachDone(s)).toBe(true)
    const answers = collectAnswers(s)
    expect(answers.preferences).toEqual([])
  })

  test('Tutor flow captures subject + style + tools', () => {
    let s: CoachState = startCoach({ leafIds: ['tutor'], preset: 'drill-sergeant', sliders: {} })
    s = advanceCoach(s, 'Algebra II, my 8th grader Sam')
    s = advanceCoach(s, 'Push them. Always show work.')
    s = advanceCoach(s, 'Yes, watch my Gmail')
    expect(isCoachDone(s)).toBe(true)

    const answers = collectAnswers(s)
    expect(answers.parameters.tutor).toMatch(/algebra/i)
    expect(answers.preferences.join(' ').toLowerCase()).toContain('push')
    expect(answers.preferences.join(' ').toLowerCase()).toContain('show work')
    expect(answers.tools).toContain('gmail')
  })

  test('Mash-up coach asks lead question', () => {
    const s = startCoach({
      leafIds: ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      preset: 'mentor', sliders: {},
    })
    expect(s.nextQuestion?.toLowerCase()).toMatch(/which|lead|bigger pain/)
  })

  test('Service coach asks schedule + sources', () => {
    // inbox-notification-triage is a Service leaf without a parameter, so
    // the Service-branch question fires (not the parameter prompt).
    const s = startCoach({ leafIds: ['inbox-notification-triage'], preset: 'mentor', sliders: {} })
    // Service-branch text from buildSteps: "What topics, sources, or schedule do you want for the …?"
    expect(s.nextQuestion?.toLowerCase()).toMatch(/sources|schedule/)
  })

  test('reflectiveAck classifies user input structurally', () => {
    let s: CoachState = startCoach({ leafIds: ['tutor'], preset: 'mentor', sliders: {} })
    s = advanceCoach(s, 'Algebra II for my 8th grader')
    expect(s.lastReflection?.kind).toBe('echo')
    expect(s.lastReflection?.text.length).toBeGreaterThan(0)

    s = startCoach({ leafIds: ['tutor'], preset: 'mentor', sliders: {} })
    const long = 'Algebra II for my 8th grader Sam — they have been struggling on word problems and need someone to push back rather than hand them answers; also their teacher emails grade reports weekly.'
    s = advanceCoach(s, long)
    expect(s.lastReflection?.kind).toBe('short')
  })

  test('cap warning surfaces when 4+ leaves', () => {
    const s = startCoach({
      leafIds: ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide', 'nutrition-partner'],
      preset: 'mentor', sliders: {},
    })
    expect(s.warnings.some(w => w.toLowerCase().includes('dilute'))).toBe(true)
  })

  test('lead question is asked for typical mash-ups', () => {
    const s = startCoach({
      leafIds: ['sleep-coach', 'stress-management-coach'],
      preset: 'mentor', sliders: {},
    })
    expect(s.nextQuestion?.toLowerCase()).toMatch(/which|lead|bigger pain/)
  })

  // Skipped until §17 #3 lead-obvious heuristic ships. Pins the contract:
  // when one leaf clearly leads (has the others in its `combinesWith` and
  // is not present in theirs), the coach should NOT ask the lead question.
  test.skip('lead question is skipped when one leaf is the obvious primary', () => {
    // TODO: enable when isObviousLead() lands
    const s = startCoach({
      leafIds: ['placeholder-primary', 'placeholder-junior-1', 'placeholder-junior-2'],
      preset: 'mentor', sliders: {},
    })
    expect(s.nextQuestion?.toLowerCase()).not.toMatch(/which|lead|bigger pain/)
  })

  test('advanceCoach does not mutate prior state', () => {
    const s0 = startCoach({ leafIds: ['tutor'], preset: 'mentor', sliders: {} })
    const s0AnswersBefore = JSON.stringify(s0.answers)
    const s1 = advanceCoach(s0, 'Algebra II for my 8th grader')
    // Prior state's answers must be unchanged
    expect(JSON.stringify(s0.answers)).toBe(s0AnswersBefore)
    // Prior state's parameters must NOT contain the new tutor entry
    expect(s0.answers.parameters.tutor).toBeUndefined()
    // New state has the captured answer
    expect(s1.answers.parameters.tutor).toBeDefined()
    // The two answer objects are different references
    expect(s0.answers).not.toBe(s1.answers)
  })

  test('reflect preserves bare affirmatives instead of swallowing them', () => {
    // Direct unit test — exercises the function without going through advanceCoach
    const { reflect } = require('../coach.js')
    expect(reflect('yes').kind).toBe('echo')
    expect(reflect('yes').text.toLowerCase()).toContain('yes')
    expect(reflect('sure').kind).toBe('echo')
    expect(reflect('ok').kind).toBe('echo')
    // The strip-prefix behavior still works for compound input:
    expect(reflect('yes, watch my Gmail').text.toLowerCase()).toContain('gmail')
    expect(reflect('yes, watch my Gmail').text.toLowerCase()).not.toContain('yes,')
  })

  test('lead-pick captures hyphenated leaf names from natural user input', () => {
    let s: CoachState = startCoach({
      leafIds: ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      preset: 'mentor', sliders: {},
    })
    // Skip Q1 (lead) by answering it
    s = advanceCoach(s, 'stress is killing me')
    expect(s.answers.leadLeafId).toBe('stress-management-coach')

    s = startCoach({
      leafIds: ['sleep-coach', 'mindfulness-meditation-guide'],
      preset: 'mentor', sliders: {},
    })
    s = advanceCoach(s, 'mindfulness please')
    expect(s.answers.leadLeafId).toBe('mindfulness-meditation-guide')
  })

  test('mash-up with parameterized leaves asks for each parameter', () => {
    const s = startCoach({
      leafIds: ['tutor', 'test-prep-coach'],
      preset: 'mentor', sliders: {},
    })
    // First question should be about subject (tutor's parameter)
    expect(s.nextQuestion?.toLowerCase()).toMatch(/subject|tutor/)
  })

  test('startCoach throws when all leaf ids are unknown', () => {
    expect(() => startCoach({ leafIds: ['no-such-leaf'], preset: 'mentor', sliders: {} }))
      .toThrow(/unknown leaf ids|no valid leaf ids/)
  })

  test('startCoach throws when some leaf ids are unknown', () => {
    expect(() => startCoach({ leafIds: ['tutor', 'no-such-leaf'], preset: 'mentor', sliders: {} }))
      .toThrow(/unknown leaf ids.*no-such-leaf/)
  })
})

describe('detectTools (exported helper)', () => {
  test('detects gmail mention', () => { expect(detectTools('Yes, watch my Gmail')).toContain('gmail') })
  test('detects oura mention', () => { expect(detectTools('I have an oura ring')).toContain('oura') })
  test('detects calendar mention', () => { expect(detectTools('Look at my calendar')).toContain('calendar') })
  test('returns empty for no mention', () => { expect(detectTools('do whatever you want')).toEqual([]) })
  test('detects multiple in one sentence', () => {
    expect(detectTools('Use my Gmail and my Calendar')).toEqual(expect.arrayContaining(['gmail', 'calendar']))
  })
})
