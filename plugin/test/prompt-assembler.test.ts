import { describe, test, expect, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { setLeavesDir, type Leaf } from '../leaves.js'
import { assembleSystemPrompt, type AssembleInputs } from '../prompt-assembler.js'

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
      parameters: { tutor: 'Algebra II' },
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
      parameters: {},
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
      parameters: {},
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
      parameters: { tutor: 'Algebra II' },
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
      parameters: { tutor: 'Algebra II' },
      identityPreamble: 'You are a tutor.',
    })
    expect(prompt).not.toContain('Specific preferences')
  })
})
