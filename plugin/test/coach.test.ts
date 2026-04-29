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
    const s = startCoach({ leafIds: ['daily-news-feed-briefing'], preset: 'mentor', sliders: {} })
    expect(s.nextQuestion?.toLowerCase()).toMatch(/topic|time|schedule/)
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
