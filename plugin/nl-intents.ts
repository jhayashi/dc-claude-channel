/**
 * NL intent classifier — detects three classes of in-chat commands the
 * dispatcher acts on before subagent dispatch:
 *   - model-switch: "switch to sonnet" / "use opus"
 *   - trust-toggle: "trust me" / "be safer" / "turn off trust"
 *   - refine: "let's refine you" / "be sharper on X"
 *
 * Pure function; deterministic given input. The dispatcher gates this
 * via shouldClassify(chatId, appSessions) so coach-in-flight messages
 * land in the coach state machine, not the classifier.
 */

import { MODELS } from './models.js'

export type Intent =
  | { kind: 'model-switch'; tier: string }
  | { kind: 'trust-toggle'; value: boolean }
  | { kind: 'refine' }
  | null

// v1.4.11 — tier alphabet derived from MODELS at module load, not
// hardcoded. Adding a tier to plugin/models.json automatically enables
// NL "switch to <tier>" without a code change. Custom IDs typed via
// the agent-setup picker do NOT get NL switching by design — NL stays
// the "curated" path; the picker is the unrestricted power-user path
// (D6 in the spec).
const TIER_ALPHABET = [...new Set(MODELS.map(m => m.tier))].join('|')

// Match commands like "switch to opus", "switch model to opus" — the
// user is directing the agent. Required: an action verb followed by a
// "to"/"model to"/"tier to" connector and the tier within ~3 words.
// Keeps "I switched majors in college" and "switch hands when you tire"
// out (the verb pattern uses `\s+` after, so past-tense "switched" can't
// match the bare "switch" alternative).
const MODEL_RE = new RegExp(
  `\\b(?:switch|change|swap|set|move|downgrade|upgrade)\\s+(?:to|over\\s+to|(?:the\\s+)?(?:model|tier)\\s+to)\\s+(?:claude\\s+)?(${TIER_ALPHABET})\\b`,
  'i',
)
// Imperative "use <tier>" / "run <tier>" — anchored to start so
// "we use claude haiku for fast tasks" stays out. Prefix list covers
// the common imperative leaders ("let's", "I want to", "we should", etc).
const MODEL_USE_RE = new RegExp(
  `^(?:please\\s+|can\\s+you\\s+|could\\s+you\\s+|would\\s+you\\s+|let'?s\\s+|i\\s+(?:want\\s+to\\s+|would\\s+like\\s+to\\s+|'d\\s+like\\s+to\\s+|just\\s+want\\s+to\\s+)|we\\s+(?:should\\s+|could\\s+|need\\s+to\\s+)|go\\s+ahead\\s+and\\s+)?(?:use|run|go\\s+with)\\s+(?:claude\\s+)?(${TIER_ALPHABET})\\b`,
  'i',
)
// "I want haiku" / "give me opus" / "make it sonnet" — preference style
// (no use/run verb). Anchored so "I read a haiku about mountains" stays
// out (sentence starts with "I read", not a preference verb).
const MODEL_PREFER_RE = new RegExp(
  `^(?:please\\s+)?(?:i\\s+(?:want|need|prefer|would\\s+like|'d\\s+like|just\\s+want)|give\\s+me|make\\s+(?:it|this)|let'?s\\s+(?:do|go\\s+with))\\s+(?:claude\\s+)?(${TIER_ALPHABET})\\b`,
  'i',
)

// Trust on/off — explicit imperatives. The phrase must stand alone (whole
// utterance, optionally with punctuation), so "build trust" / "trust fund"
// / "lost trust" / "enable trust between siblings" / "trust your gut"
// don't match. We do, however, allow trailing clauses ("trust me, switch
// to opus") via a non-capturing trailing-clause clause so trust takes
// precedence over a co-occurring model-switch phrase.
const TRUST_ON_CORE = String.raw`(?:trust\s+me|trust\s+this(?:\s+(?:agent|chat))?|i\s+trust\s+(?:you|this|it)|turn\s+on\s+(?:your\s+)?trust|enable\s+(?:your\s+)?trust|skip\s+(?:my\s+)?permission(?:s)?)`
const TRUST_OFF_CORE = String.raw`(?:be\s+safer|untrust(?:\s+this(?:\s+(?:agent|chat))?)?|i\s+don'?t\s+trust\s+(?:you|this|it)|stop\s+trusting(?:\s+(?:yourself|this))?|remove\s+(?:your\s+)?trust|turn\s+off\s+(?:your\s+)?trust|disable\s+(?:your\s+)?trust|stop\s+skipping\s+permissions?|ask\s+(?:me\s+)?before(?:\s+(?:running\s+)?tools?)?|require\s+permissions?)`
const TRUST_ON_RE = new RegExp(String.raw`^(?:please\s+)?` + TRUST_ON_CORE + String.raw`(?:\s+now)?(?:\s*[,.;!?].*)?$`, 'i')
const TRUST_OFF_RE = new RegExp(String.raw`^(?:please\s+)?` + TRUST_OFF_CORE + String.raw`(?:\s*[,.;!?].*)?$`, 'i')

// Refine — the user wants the AGENT to change, not the world. The
// payload-bearing nouns must be agent-self ("you", "your prompt",
// "your tone", etc.) — NOT generic objects ("recipe", "resume").
const REFINE_DIRECT_RE = /^(?:please\s+)?(?:let'?s\s+(?:refine|tweak)\s+you|i\s+want\s+to\s+(?:tweak|refine|change)\s+(?:you|your))/i
const REFINE_TARGETED_RE = /\b(?:refine|tweak|adjust|sharpen|update|change|edit)\s+(?:you|your\s+(?:prompt|tone|style|approach|behavior|voice))\b/i
// "be sharper on X", "be more X" — only at start of utterance so
// "Be more careful with the dosage" must be excluded explicitly via the
// adjective whitelist (we deliberately omit "careful").
const REFINE_DIRECTIVE_RE = /^(?:please\s+)?be\s+(?:sharper|gentler|stricter|kinder|terser|chattier|funnier|drier)\b/i

// Quote/code detection: if the matched substring is wrapped in straight
// or curly quotes, the user is reporting speech, not commanding.
function isInQuotes(text: string, matchStart: number, matchEnd: number): boolean {
  // Count quote characters (straight + curly) before the match. If the
  // count is odd, we're inside an open quote; check that a closing quote
  // appears after the match too.
  const quoteRe = /["'“”‘’]/g
  const before = text.slice(0, matchStart)
  const after = text.slice(matchEnd)
  const beforeCount = (before.match(quoteRe) || []).length
  return beforeCount % 2 === 1 && quoteRe.test(after)
}

export function classifyIntent(text: string): Intent {
  const t = text.trim()
  if (!t) return null

  // Trust on/off (precedence: trust phrasing wins over model — see test
  // "trust me, switch to opus" → trust-toggle).
  if (TRUST_ON_RE.test(t)) return { kind: 'trust-toggle', value: true }
  if (TRUST_OFF_RE.test(t)) return { kind: 'trust-toggle', value: false }

  // Model switch — only if the action verb + tier appear AND not inside quotes.
  let m = MODEL_RE.exec(t)
  if (m && !isInQuotes(t, m.index, m.index + m[0].length)) {
    return { kind: 'model-switch', tier: m[1].toLowerCase() }
  }
  m = MODEL_USE_RE.exec(t)
  if (m && !isInQuotes(t, m.index, m.index + m[0].length)) {
    return { kind: 'model-switch', tier: m[1].toLowerCase() }
  }
  m = MODEL_PREFER_RE.exec(t)
  if (m && !isInQuotes(t, m.index, m.index + m[0].length)) {
    return { kind: 'model-switch', tier: m[1].toLowerCase() }
  }

  // Refine
  if (REFINE_DIRECT_RE.test(t)) return { kind: 'refine' }
  if (REFINE_TARGETED_RE.test(t)) return { kind: 'refine' }
  if (REFINE_DIRECTIVE_RE.test(t)) return { kind: 'refine' }

  return null
}

/**
 * Call-site gate: skip intent classification when a chat is in coach-mode.
 * Coach answers like "use Sonnet for this tutoring task" should land in
 * the coach state machine, not mutate the agent's model setting.
 *
 * Used by the dispatcher's per-turn pipeline before invoking classifyIntent.
 */
export function shouldClassify(chatId: number, appSessions: Map<number, unknown>): boolean {
  return !appSessions.has(chatId)
}
