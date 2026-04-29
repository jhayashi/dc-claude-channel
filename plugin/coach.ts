import { findLeaf } from './leaves.js'
import type { PresetId, SliderState } from './personality-presets.js'

interface QuestionStep {
  id: string
  question: (ctx: CoachInputs) => string
  capture: (s: CoachState, answer: string) => void
}

export interface CoachInputs {
  leafIds: string[]
  preset: PresetId
  sliders: SliderState
}

export interface CoachAnswers {
  parameters: Record<string, string>
  preferences: string[]
  tools: string[]
  leadLeafId?: string
}

export interface RefineInputs {
  agentId: string
  existingPrompt: string
}

export interface Reflection {
  kind: 'echo' | 'short' | 'skip'
  text: string
}

export interface CoachState {
  inputs: CoachInputs
  remaining: QuestionStep[]
  answers: CoachAnswers
  nextQuestion: string | null
  lastReflection: Reflection | null
  warnings: string[]
  /** Set when the state was created via startRefineCoach (Phase 11). */
  refineContext?: RefineInputs
}

const SKIP_PATTERN = /^(let'?s go|just go|skip|use defaults)\b/i

const TOOL_HINTS: Array<[RegExp, string]> = [
  [/\bgmail\b/i, 'gmail'],
  [/\bcalendar\b/i, 'calendar'],
  [/\boura\b/i, 'oura'],
  [/\bapple\s*health\b/i, 'apple-health'],
  [/\bgithub\b/i, 'github'],
  [/\bslack\b/i, 'slack'],
]

export function reflect(text: string): Reflection {
  // Compact echo of the user's answer for the reflect-always pattern.
  // Returns a structured object so tests can assert on `kind` rather
  // than fuzzy substring-matching the rendered string.
  const clean = text.trim().replace(/^(yes,?\s*|sure,?\s*|ok,?\s*)/i, '')
  if (clean.length === 0) return { kind: 'skip', text: '' }
  if (clean.length <= 60) return { kind: 'echo', text: `Got it: ${clean}.` }
  return { kind: 'short', text: 'Got it.' }
}

export function detectTools(text: string): string[] {
  return TOOL_HINTS.filter(([re]) => re.test(text)).map(([, tool]) => tool)
}

function buildSteps(inputs: CoachInputs): QuestionStep[] {
  const leaves = inputs.leafIds.map(findLeaf).filter((l): l is NonNullable<ReturnType<typeof findLeaf>> => l !== null)
  const steps: QuestionStep[] = []

  // Q1 — parameter (single leaf with parameter) OR lead pick (mash-up) OR schedule (service)
  if (leaves.length === 1) {
    const l = leaves[0]
    if (l.parameter) {
      steps.push({
        id: 'parameter',
        question: () => `Got it — a ${l.name.toLowerCase()}. ${parameterPrompt(l.parameter!, l.name)}`,
        capture: (s, a) => { s.answers.parameters[l.id] = a },
      })
    } else if (l.path === 'Service') {
      steps.push({
        id: 'service',
        question: () => `What topics, sources, or schedule do you want for the ${l.name.toLowerCase()}?`,
        capture: (s, a) => { s.answers.preferences.push(a) },
      })
    }
  } else {
    steps.push({
      id: 'lead',
      question: () => `Which of these specialties is the bigger pain right now: ${leaves.map(l => l.name).join(', ')}?`,
      capture: (s, a) => {
        const matched = leaves.find(l => a.toLowerCase().includes(l.name.split(/\s/)[0].toLowerCase()))
        if (matched) s.answers.leadLeafId = matched.id
        s.answers.preferences.push(`User said the lead concern is: ${a}`)
      },
    })
  }

  // Q2 — voice / style
  steps.push({
    id: 'voice',
    question: () => `How direct should I be — gentle nudge, or pull no punches?`,
    capture: (s, a) => { s.answers.preferences.push(`Tone preference: ${a}`) },
  })

  // Q3 — tools / monitoring
  steps.push({
    id: 'tools',
    question: () => `Are there services I should connect to (Gmail, calendar, Oura, etc.) or skip?`,
    capture: (s, a) => {
      s.answers.tools.push(...detectTools(a))
      s.answers.preferences.push(`Tools/monitoring: ${a}`)
    },
  })

  return steps
}

function parameterPrompt(parameter: string, leafName: string): string {
  const map: Record<string, string> = {
    'subject': 'What subject, and who is the learner?',
    'target language': 'What language, and where are you starting from?',
    'which test': 'Which test, and how long until it?',
    'writing type': 'What kind of writing, and what is the deadline?',
    'cuisine': 'Which cuisine?',
    'genre': 'What genre, and what is the project?',
    'species': 'What species, and what is the behavior issue?',
    'goal (weight loss, 5K, hypertrophy, mobility)': 'What is the specific goal?',
    'tradition': 'Which tradition?',
    'topic': 'What is the topic?',
  }
  return map[parameter] || `What ${parameter.replace(/[()]/g, '')}?`
}

export function startCoach(inputs: CoachInputs): CoachState {
  const remaining = buildSteps(inputs)
  const warnings: string[] = []
  if (inputs.leafIds.length >= 4) {
    warnings.push('Adding more may dilute the agent\'s focus. Three is usually the sweet spot.')
  }
  const state: CoachState = {
    inputs,
    remaining,
    answers: { parameters: {}, preferences: [], tools: [] },
    nextQuestion: null,
    lastReflection: null,
    warnings,
  }
  state.nextQuestion = remaining[0]?.question(inputs) ?? null
  return state
}

export function advanceCoach(s: CoachState, userMessage: string): CoachState {
  if (SKIP_PATTERN.test(userMessage.trim())) {
    return {
      ...s,
      remaining: [],
      nextQuestion: null,
      lastReflection: { kind: 'echo', text: 'Got it — going with defaults.' },
    }
  }
  const step = s.remaining[0]
  if (!step) return s
  step.capture(s, userMessage)
  const remaining = s.remaining.slice(1)
  const nextQuestion = remaining[0]?.question(s.inputs) ?? null
  return { ...s, remaining, nextQuestion, lastReflection: reflect(userMessage) }
}

export function isCoachDone(s: CoachState): boolean {
  return s.remaining.length === 0
}

export function collectAnswers(s: CoachState): CoachAnswers {
  return s.answers
}
