import { type Catalog, type Leaf, getDefaultCatalog } from './leaves.js'
import type { PresetId, SliderState } from './personality-presets.js'

interface QuestionStep {
  id: string
  question: (ctx: CoachInputs) => string
  capture: (a: CoachAnswers, answer: string) => CoachAnswers
}

/**
 * Refine-mode context: when the coach is editing an existing agent
 * rather than building a new one, the caller hands in the agent id +
 * its current system prompt so the assembler can do an incremental
 * rewrite (preserve Identity / Expertise / Scope, splice in new
 * Preferences). Set on `CoachInputs.refineContext` to flip the coach
 * into single-question refine mode.
 */
export interface RefineInputs {
  agentId: string
  existingPrompt: string
}

export interface CoachInputs {
  leafIds: string[]
  preset: PresetId
  sliders: SliderState
  /** Optional catalog handle. Defaults to the production singleton. */
  catalog?: Catalog
  /** When set, the coach asks the single Refine question instead of
   *  the new-agent flow. Stashed on `CoachState.refineContext` so the
   *  assembler can apply an incremental rewrite. */
  refineContext?: RefineInputs
}

export interface CoachAnswers {
  parameters: Record<string, string>
  preferences: string[]
  tools: string[]
  leadLeafId?: string
}

export interface Reflection {
  kind: 'echo' | 'short'
  text: string
}

export interface CoachState {
  inputs: CoachInputs
  remaining: QuestionStep[]
  answers: CoachAnswers
  nextQuestion: string | null
  lastReflection: Reflection | null
  warnings: string[]
  /** Mirror of `inputs.refineContext` — kept on the top-level state so
   *  the dispatcher's coach-done branch can decide between graduate-new
   *  vs graduate-refine without re-reading inputs. */
  refineContext: RefineInputs | undefined
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

export function reflect(text: string): Reflection | null {
  // Compact echo of the user's answer for the reflect-always pattern.
  // Returns null when there's nothing meaningful to reflect (empty
  // input after stripping leading affirmations) — caller suppresses
  // the chat-side reflection in that case.
  const trimmed = text.trim()
  const stripped = trimmed.replace(/^(yes,?\s*|sure,?\s*|ok,?\s*)/i, '')
  const clean = stripped.length === 0 ? trimmed : stripped
  if (clean.length === 0) return null
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

/**
 * Predicate: when one leaf in a mash-up is obviously the "lead" we can
 * skip the lead-pick question and pre-fill `answers.leadLeafId`.
 *
 * Heuristic (v1): when two-or-more leaves are mixed and EXACTLY one of
 * them lives on the `Service` path, that Service leaf is the lead.
 * Captures the news-feed-briefing-plus-coach scenario where the Service
 * is the always-on driver and the Expert/Goal leaves are the lens.
 *
 * Returns the lead leaf id, or null when no leaf is obviously primary.
 */
export function isObviousLead(leaves: Leaf[]): string | null {
  if (leaves.length < 2) return null
  const services = leaves.filter(l => l.path === 'Service')
  if (services.length === 1) return services[0].id
  return null
}

interface StepCtx {
  leaves: Leaf[]
  refineContext: RefineInputs | undefined
}

function parameterStep(l: Leaf, ctx: StepCtx): QuestionStep {
  const suffix = ctx.leaves.length > 1 ? ` (For your ${l.name.toLowerCase()}.)` : ''
  const intro = ctx.leaves.length === 1 ? `Got it — a ${l.name.toLowerCase()}. ` : ''
  return {
    id: `parameter-${l.id}`,
    question: () => `${intro}${parameterPrompt(l.parameter!, l.name)}${suffix}`,
    capture: (a, ans) => ({
      ...a,
      parameters: { ...a.parameters, [l.id]: ans },
    }),
  }
}

function leadStep(ctx: StepCtx): QuestionStep | null {
  if (ctx.leaves.length <= 1) return null
  if (isObviousLead(ctx.leaves) !== null) return null
  const leaves = ctx.leaves
  return {
    id: 'lead',
    question: () => `Which of these specialties is the bigger pain right now: ${leaves.map(l => l.name).join(', ')}?`,
    capture: (a, ans) => {
      const matched = leaves.find(l => matchesLeafName(ans, l.name))
      // Fall back to the first leaf when the matcher misses — better than leaving
      // leadLeafId undefined, which downstream assembler would reject.
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
  }
}

function serviceStep(ctx: StepCtx): QuestionStep | null {
  if (ctx.leaves.length !== 1) return null
  const l = ctx.leaves[0]
  if (l.path !== 'Service' || l.parameter) return null
  return {
    id: 'service',
    question: () => `What topics, sources, or schedule do you want for the ${l.name.toLowerCase()}?`,
    capture: (a, ans) => ({ ...a, preferences: [...a.preferences, ans] }),
  }
}

function voiceStep(_ctx: StepCtx): QuestionStep {
  return {
    id: 'voice',
    question: () => `How direct should I be — gentle nudge, or pull no punches?`,
    capture: (a, ans) => ({ ...a, preferences: [...a.preferences, `Tone preference: ${ans}`] }),
  }
}

function toolsStep(_ctx: StepCtx): QuestionStep {
  return {
    id: 'tools',
    question: () => `Are there services I should connect to (Gmail, calendar, Oura, etc.) or skip?`,
    capture: (a, ans) => ({
      ...a,
      tools: [...a.tools, ...detectTools(ans)],
      preferences: [...a.preferences, `Tools/monitoring: ${ans}`],
    }),
  }
}

function refineStep(_ctx: StepCtx): QuestionStep {
  return {
    id: 'refine',
    question: () => `What would you like to change about how I work?`,
    capture: (a, ans) => ({ ...a, preferences: [...a.preferences, ans] }),
  }
}

function buildSteps(inputs: CoachInputs, catalog: Catalog): QuestionStep[] {
  const leaves = inputs.leafIds
    .map(id => catalog.findLeaf(id))
    .filter((l): l is Leaf => l !== null)
  const ctx: StepCtx = { leaves, refineContext: inputs.refineContext }

  // Refine mode short-circuits the build path: we're editing an
  // existing agent, so the only question we ask is the open-ended
  // "what would you like to change?" — voice / tools / lead / parameter
  // are out of scope for this flow.
  if (ctx.refineContext) {
    return [refineStep(ctx)]
  }

  const parameterized = leaves.filter(l => l.parameter)
  const candidates: Array<QuestionStep | null> = [
    ...parameterized.map(l => parameterStep(l, ctx)),
    leadStep(ctx),
    serviceStep(ctx),
    voiceStep(ctx),
    toolsStep(ctx),
  ]
  return candidates.filter((s): s is QuestionStep => s !== null)
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
  // Pre-fill leadLeafId when one leaf is the obvious primary so the
  // skipped lead step doesn't leave the assembler with leadLeafId unset.
  const leaves = inputs.leafIds
    .map(id => catalog.findLeaf(id))
    .filter((l): l is Leaf => l !== null)
  const obvious = isObviousLead(leaves)
  const initialAnswers: CoachAnswers = { parameters: {}, preferences: [], tools: [] }
  if (obvious) initialAnswers.leadLeafId = obvious

  const state: CoachState = {
    inputs,
    remaining,
    answers: initialAnswers,
    nextQuestion: null,
    lastReflection: null,
    warnings,
    refineContext: inputs.refineContext,
  }
  state.nextQuestion = remaining[0]?.question(inputs) ?? null
  return state
}

/**
 * Refine-mode coach. The user has an existing bound agent and wants
 * to tweak it; we ask one open-ended question and let the assembler's
 * `refineSystemPrompt` splice the answer into the live prompt.
 */
export function startRefineCoach(inputs: RefineInputs): CoachState {
  // Refine mode doesn't depend on the leaf catalog — we're editing an
  // existing prompt, not composing a new one. We pass [] for leafIds
  // and skip the leaf-validation guard. The buildSteps/refineContext
  // path returns just the single Refine question.
  const coachInputs: CoachInputs = {
    leafIds: [],
    preset: 'mentor',
    sliders: {},
    refineContext: inputs,
  }
  // Hand-build remaining: buildSteps requires a catalog (even if it
  // doesn't touch it for refine), but the refineStep is independent
  // of catalog state. Build it directly to avoid threading a catalog
  // we don't need.
  const ctx: StepCtx = { leaves: [], refineContext: inputs }
  const remaining = [refineStep(ctx)]
  const state: CoachState = {
    inputs: coachInputs,
    remaining,
    answers: { parameters: {}, preferences: [], tools: [] },
    nextQuestion: remaining[0]!.question(coachInputs),
    lastReflection: null,
    warnings: [],
    refineContext: inputs,
  }
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
