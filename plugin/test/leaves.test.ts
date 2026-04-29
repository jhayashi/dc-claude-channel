import { describe, test, expect } from 'bun:test'
import { LeafSchema, type Leaf } from '../leaves.js'

describe('LeafSchema', () => {
  test('parses a minimal leaf', () => {
    const raw = {
      id: 'sleep-coach',
      path: 'Expert',
      l2: 'Health, wellness, caregiving',
      name: 'Sleep coach',
      pitch: 'Diagnoses your sleep with you, designs a sleep-hygiene plan, and tracks results. Can monitor your tracker data and surface what changed week-over-week.',
      expertise: 'As a sleep coach, build and maintain a sleep-hygiene plan with the user; read tracker data weekly and surface what changed.',
    }
    const parsed = LeafSchema.parse(raw)
    expect(parsed.id).toBe('sleep-coach')
    expect(parsed.path).toBe('Expert')
    expect(parsed.parameter).toBeNull()
    expect(parsed.liability).toBeNull()
    expect(parsed.combinesWith).toEqual([])
    expect(parsed.suggestedTools).toEqual([])
  })

  test('parses a fully-populated leaf', () => {
    const raw = {
      id: 'tutor',
      path: 'Expert',
      l2: 'Education',
      name: 'Tutor',
      parameter: 'subject',
      liability: null,
      pitch: 'Teaches a subject from where you actually are. Tracks what you have mastered.',
      expertise: 'As a tutor, teach from where the learner is. Diagnose gaps before reteaching.',
      combinesWith: ['test-prep-coach', 'writing-coach', 'education-milestone'],
      suggestedTools: ['gmail'],
    }
    const parsed = LeafSchema.parse(raw)
    expect(parsed.parameter).toBe('subject')
    expect(parsed.combinesWith).toHaveLength(3)
  })

  test('rejects unknown path', () => {
    expect(() =>
      LeafSchema.parse({ id: 'x', path: 'Other', l2: 'X', name: 'X', pitch: 'X', expertise: 'X' })
    ).toThrow()
  })

  test('rejects unknown liability flag', () => {
    expect(() =>
      LeafSchema.parse({ id: 'x', path: 'Expert', l2: 'X', name: 'X', pitch: 'X', expertise: 'X', liability: 'fishery' })
    ).toThrow()
  })
})
