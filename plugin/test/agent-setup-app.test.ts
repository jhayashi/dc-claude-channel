import { describe, test, expect, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { setLeavesDir, getDefaultCatalog } from '../leaves.js'
import {
  composeIdentityPreamble,
  composeAgentName,
} from '../apps/agent-setup-app.js'
import type { CoachAnswers } from '../coach.js'

beforeEach(() => {
  setLeavesDir(join(import.meta.dir, '..', 'leaves'))
})

const empty: CoachAnswers = { parameters: {}, preferences: [], tools: [] }

describe('composeIdentityPreamble', () => {
  test('single leaf, no parameter', () => {
    const out = composeIdentityPreamble(['sleep-coach'], empty, getDefaultCatalog())
    expect(out.toLowerCase()).toContain('sleep coach')
    expect(out).toMatch(/^You are a /)
  })

  test('single leaf with parameter (Tutor / Algebra II)', () => {
    const answers: CoachAnswers = {
      parameters: { tutor: 'Algebra II' },
      preferences: [],
      tools: [],
    }
    const out = composeIdentityPreamble(['tutor'], answers, getDefaultCatalog())
    expect(out).toContain('Algebra II')
    expect(out.toLowerCase()).toContain('tutor')
  })

  test('mash-up with explicit lead', () => {
    const answers: CoachAnswers = {
      parameters: {},
      preferences: [],
      tools: [],
      leadLeafId: 'sleep-coach',
    }
    const out = composeIdentityPreamble(
      ['sleep-coach', 'stress-management-coach'],
      answers,
      getDefaultCatalog(),
    )
    expect(out).toContain('Sleep coach')
    expect(out).toContain('Stress-management coach')
    expect(out.toLowerCase()).toContain('lead lens')
  })

  test('mash-up without lead falls back to equal partners', () => {
    const out = composeIdentityPreamble(
      ['sleep-coach', 'stress-management-coach'],
      empty,
      getDefaultCatalog(),
    )
    expect(out.toLowerCase()).toContain('equal partners')
  })

  test('unknown leaf id silently dropped (no crash)', () => {
    // Defense-in-depth — composer is downstream of validation but should
    // not blow up on a bad id slipping through. Filter drops the unknown
    // id so the result is the same generic fallback as `[]`.
    const out = composeIdentityPreamble(['no-such-leaf-id'], empty, getDefaultCatalog())
    expect(out).toBe('You are a helpful assistant.')
  })

  test('empty leafIds yields a generic fallback', () => {
    const out = composeIdentityPreamble([], empty, getDefaultCatalog())
    expect(out.toLowerCase()).toContain('helpful assistant')
  })
})

describe('composeAgentName', () => {
  test('single leaf, no parameter', () => {
    const name = composeAgentName(['sleep-coach'], empty, getDefaultCatalog())
    expect(name).toBe('Sleep coach')
  })

  test('single leaf with parameter', () => {
    const answers: CoachAnswers = {
      parameters: { tutor: 'Algebra II' },
      preferences: [],
      tools: [],
    }
    const name = composeAgentName(['tutor'], answers, getDefaultCatalog())
    expect(name).toBe('Tutor (Algebra II)')
  })

  test('mash-up with explicit lead', () => {
    const answers: CoachAnswers = {
      parameters: {},
      preferences: [],
      tools: [],
      leadLeafId: 'sleep-coach',
    }
    const name = composeAgentName(
      ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      answers,
      getDefaultCatalog(),
    )
    expect(name).toBe('Sleep coach + 2 more')
  })

  test('mash-up without lead defaults to first leaf', () => {
    const name = composeAgentName(
      ['sleep-coach', 'stress-management-coach'],
      empty,
      getDefaultCatalog(),
    )
    expect(name).toBe('Sleep coach + 1 more')
  })

  test('empty leafIds returns generic name', () => {
    const name = composeAgentName([], empty, getDefaultCatalog())
    expect(name).toBe('New agent')
  })
})
