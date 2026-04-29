import { describe, test, expect } from 'bun:test'
import {
  PRESETS,
  renderVoice,
  type PresetId,
  type SliderState,
} from '../personality-presets.js'

describe('Personality presets', () => {
  test('exports five presets', () => {
    expect(Object.keys(PRESETS)).toEqual(['coach', 'drill-sergeant', 'mentor', 'pal', 'professor'])
  })

  test('renderVoice with bare preset returns the preset snippet', () => {
    const v = renderVoice('drill-sergeant', {})
    expect(v).toContain('Drill Sergeant')
    expect(v).toContain('Terse')
  })

  test('renderVoice applies Educator Socratic↔Direct slider', () => {
    const directV = renderVoice('mentor', { socratic: 'direct' } as SliderState)
    expect(directV).toContain('Direct')

    const socraticV = renderVoice('mentor', { socratic: 'socratic' } as SliderState)
    expect(socraticV).toContain('Socratic')
  })

  test('renderVoice ignores unknown sliders gracefully', () => {
    const v = renderVoice('coach', { unknown: 'value' } as unknown as SliderState)
    expect(v).toContain('Coach')
  })
})
