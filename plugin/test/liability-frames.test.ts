import { describe, test, expect } from 'bun:test'
import { renderLiability, LIABILITY_FRAMES } from '../liability-frames.js'

describe('Liability frames', () => {
  test('renders a frame for each known flag', () => {
    for (const flag of Object.keys(LIABILITY_FRAMES)) {
      const frame = renderLiability(flag as any)
      expect(frame.length).toBeGreaterThan(50)
      expect(frame.toLowerCase()).toContain('not')  // some form of "you are not a..."
    }
  })

  test('returns empty string for null', () => {
    expect(renderLiability(null)).toBe('')
  })

  test('medical frame mentions clinician language', () => {
    const f = renderLiability('medical')
    expect(f.toLowerCase()).toMatch(/clinician|provider|doctor|medical/)
  })

  test('legal frame mentions attorney language', () => {
    const f = renderLiability('legal')
    expect(f.toLowerCase()).toMatch(/attorney|lawyer|counsel|legal advice/)
  })
})
