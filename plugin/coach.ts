import { type Catalog, getDefaultCatalog } from './leaves.js'
import type { PresetId, SliderState } from './personality-presets.js'

interface QuestionStep {
  id: string
  question: (ctx: CoachInputs) => string
  capture: (a: CoachAnswers, answer: string) => CoachAnswers
}

export interface CoachInputs {
  leafIds: string[]
  preset: PresetId
  sliders: SliderState
  /** Optional catalog handle. Defaults to the production singleton. */
  catalog?: Catalog
}

export interface CoachAnswers {
  parameters: Record<string, string>
  preferences: string[]
  tools: string[]
  leadLeafId?: string
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
  const trimmed = text.trim()
  const stripped = trimmed.replace(/^(yes,?\s*|sure,?\s*|ok,?\s*)/i, '')
  const clean = stripped.length === 0 ? trimmed : stripped
  if (clean.length === 0) return { kind: 'skip', text: '' }
  if (clean.length <= 60) return { kind: 'echo', text: `Got it: ${clean}.` }
  return { kind: 'short', text: 'Got it.' }
}

export function detectTools(text: string): string[] {
  return TOOL_HINTS.filter(([re]) => re.test(text)).map(([, tool]) => tool)
}

function matchesLeafName(answer: string, leafName: string): boolean {
  // Token-based match — tolerate hyphens, slashes, and spaces, and skip
  // very short tokens that would false-positive on common words.
  const ans = answer.toLowerCase()
  const tokens = leafName.toLowerCase().split(/[\s\-/]+/).filter(t => t.length >= 4)
  return tokens.some(t => ans.includes(t))
}

function buildSteps(inputs: CoachInputs, catalog: Catalog): QuestionStep[] {
  const leaves = inputs.leafIds.map(id => catalog.findLeaf(id)).filter((l): l is NonNullable<ReturnType<Catalog['findLeaf']>> => l !== null)
  const steps: QuestionStep[] = []

  // Q1a — parameter steps (one per parameterized leaf — works for both
  // single-leaf and mash-up). When two parameterized leaves are stacked
  // we append "(For your <leaf name>)" so the user knows which leaf the
  // question is about.
  const parameterized = leaves.filter(l => l.parameter)
  for (const l of parameterized) {
    const suffix = leaves.length > 1 ? ` (For your ${l.name.toLowerCase()}.)` : ''
    const intro = leaves.length === 1 ? `Got it — a ${l.name.toLowerCase()}. ` : ''
    steps.push({
      id: `parameter-${l.id}`,
      question: () => `${intro}${parameterPrompt(l.parameter!, l.name)}${suffix}`,
      capture: (a, ans) => ({
        ...a,
        parameters: { ...a.parameters, [l.id]: ans },
      }),
    })
  }

  // Q1b — lead-pick (only for mash-ups)
  if (leaves.length > 1) {
    steps.push({
      id: 'lead',
      question: () => `Which of these specialties is the bigger pain right now: ${leaves.map(l => l.name).join(', ')}?`,
      capture: (a, ans) => {
        const matched = leaves.find(l => matchesLeafName(ans, l.name))
        // Fall back to the first leaf when the matcher misses — better than leaving
        // leadLeafId undefined, which downstream assembler would reject.
        // (`a.leadLeafId` was a dead middle branch — this is the only step
        // that ever sets it, so it's always undefined when capture runs.)
        const leadId = matched?.id ?? leaves[0].id
        return {
          ...a,
          leadLeafId: leadId,
          preferences: [
            ...a.preferences,
            `User said the lead concern is: ${ans}`,
            ...(matched ? [] : [`(coach guessed lead = ${leadId} since the user's answer didn't match a leaf name)`]),
          ],
        }
      },
    })
  } else if (leaves[0].path === 'Service' && !leaves[0].parameter) {
    // Q1c — service-only (single Service leaf without parameter)
    const l = leaves[0]
    steps.push({
      id: 'service',
      question: () => `What topics, sources, or schedule do you want for the ${l.name.toLowerCase()}?`,
      capture: (a, ans) => ({ ...a, preferences: [...a.preferences, ans] }),
    })
  }

  // Q2 — voice / style
  steps.push({
    id: 'voice',
    question: () => `How direct should I be — gentle nudge, or pull no punches?`,
    capture: (a, ans) => ({ ...a, preferences: [...a.preferences, `Tone preference: ${ans}`] }),
  })

  // Q3 — tools / monitoring
  steps.push({
    id: 'tools',
    question: () => `Are there services I should connect to (Gmail, calendar, Oura, etc.) or skip?`,
    capture: (a, ans) => ({
      ...a,
      tools: [...a.tools, ...detectTools(ans)],
      preferences: [...a.preferences, `Tools/monitoring: ${ans}`],
    }),
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
  const catalog = inputs.catalog ?? getDefaultCatalog()
  // Defense-in-depth: dispatcher should validate first, but if a leaf
  // disappears between validation and coach-start, fail loud rather than
  // produce a malformed mash-up question.
  const validLeafIds = inputs.leafIds.filter(id => catalog.findLeaf(id) !== null)
  if (validLeafIds.length === 0) {
    throw new Error(`startCoach: no valid leaf ids in ${inputs.leafIds.join(', ') || '(empty)'}`)
  }
  if (validLeafIds.length !== inputs.leafIds.length) {
    const missing = inputs.leafIds.filter(id => catalog.findLeaf(id) === null)
    throw new Error(`startCoach: unknown leaf ids: ${missing.join(', ')}`)
  }
  const remaining = buildSteps(inputs, catalog)
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
  const answers = step.capture(s.answers, userMessage)
  const remaining = s.remaining.slice(1)
  const nextQuestion = remaining[0]?.question(s.inputs) ?? null
  return { ...s, answers, remaining, nextQuestion, lastReflection: reflect(userMessage) }
}

export function isCoachDone(s: CoachState): boolean {
  return s.remaining.length === 0
}

export function collectAnswers(s: CoachState): CoachAnswers {
  return s.answers
}
