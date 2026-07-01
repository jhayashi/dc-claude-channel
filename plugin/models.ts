/**
 * Model registry — single source of truth for available model IDs,
 * their display labels, tier buckets, and tier-level default system
 * prompts. Backs the agent-setup dropdowns, the dc_create_agent and
 * dc_update_agent tool enums, and the icon chooser.
 *
 * The manifest is read from plugin/models.json at module load. To add
 * or retire a model, edit that JSON and restart the dispatcher. The
 * agent-setup WebXDC card receives the list in its init payload and
 * renders the dropdown dynamically, so no HTML changes are needed.
 */

import { readFileSync } from 'node:fs'

// v1.4.11 — tier is opaque `string`, not a closed union. plugin/models.json
// is a curated convenience list, not a gatekeeper. User-typed IDs in the
// agent-setup picker get their tier inferred via TIER_FROM_ID_RE below.
// Kept as a type alias (not deleted) so existing imports continue to
// compile through v1.4.x; remove in v1.5.0 once all consumers reference
// `string` directly.
export type ModelTier = string

/**
 * Reasoning effort levels accepted by `claude --effort <level>` (CLI 2.1+).
 * Per-agent override; absent = use the CLI's persisted default.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = typeof EFFORT_LEVELS[number]
export function isEffortLevel(s: string): s is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(s)
}

export interface ModelEntry {
  id: string
  label: string
  tier: ModelTier
  inheritClaudeMd: boolean
}

interface ModelsManifest {
  default: string
  models: ModelEntry[]
  tierSystemPrompts: Partial<Record<ModelTier, string>>
}

const MANIFEST: ModelsManifest = JSON.parse(
  readFileSync(new URL('./models.json', import.meta.url), 'utf8'),
)

if (!MANIFEST.models.some(m => m.id === MANIFEST.default)) {
  throw new Error(`models.json: default "${MANIFEST.default}" is not in the models list`)
}

export const MODELS: readonly ModelEntry[] = MANIFEST.models
export const MODEL_IDS: readonly string[] = MANIFEST.models.map(m => m.id)
export const DEFAULT_MODEL: string = MANIFEST.default

export function getModel(id: string): ModelEntry | undefined {
  return MANIFEST.models.find(m => m.id === id)
}

export function isKnownModel(id: string): boolean {
  return getModel(id) !== undefined
}

/**
 * Whether an agent on this model should inherit the dispatcher's
 * CLAUDE.md. Unknown models default to true (safer to include context
 * than to strip it silently).
 */
export function inheritClaudeMdForModel(id: string): boolean {
  return getModel(id)?.inheritClaudeMd ?? true
}

/**
 * v1.4.11 — claude-<tier>-<N>-<N> ID prefix. When the manifest doesn't
 * know an ID, we extract the tier from the ID itself. Non-Anthropic IDs
 * (gpt-4, llama-…) don't match, so they return 'unknown' — which the
 * badge renderer resolves to UNKNOWN_MODEL_COLOR (Zinc-grey).
 */
const TIER_FROM_ID_RE = /^claude-([a-z]+)-/i

/**
 * Tier bucket for icon/prompt lookups. Manifest-first lookup wins;
 * unknown IDs fall back to a regex extract on the claude-<tier>- prefix.
 * IDs that don't match the regex return 'unknown' — the renderer falls
 * through to UNKNOWN_MODEL_COLOR.
 */
export function tierForModel(id: string): string {
  const known = getModel(id)
  if (known) return known.tier
  const m = TIER_FROM_ID_RE.exec(id)
  return m ? m[1].toLowerCase() : 'unknown'
}

/**
 * v1.4.11 — whether an id is acceptable as an agent's `model`: either a
 * manifest-known id OR a claude-<tier>-* id the manifest doesn't yet know
 * (a future/preview model like claude-sonnet-5-0). Custom claude ids are
 * passed verbatim to `claude --model` at spawn, which does the final
 * validation. Non-claude / garbage ids (gpt-4, not-a-real-model) are still
 * rejected so typos surface at save/load rather than bricking the agent.
 *
 * Why load must be lenient: the shared `claude-code` default agent can be
 * re-pointed to any model from terminal CC. A strict isKnownModel gate made
 * getAgent() return null for an unknown id, so resolveChat() reported the
 * agent as deleted for EVERY bound chat.
 */
export function isAcceptableModelId(id: string): boolean {
  return isKnownModel(id) || TIER_FROM_ID_RE.test(id)
}

/**
 * Latest (newest) model id for a tier. Relies on models.json being
 * ordered newest-first per tier.
 */
export function latestModelForTier(tier: ModelTier): string {
  for (const m of MODELS) {
    if (m.tier === tier) return m.id
  }
  throw new Error(`no model found for tier ${tier}`)
}

export function labelForModel(id: string): string {
  return getModel(id)?.label ?? id
}

/**
 * Tier-level default system prompt used when seeding a draft agent from
 * a description. Returns undefined when the tier has no tailored prompt
 * (caller falls back to a generic default).
 */
export function systemPromptForTier(tier: ModelTier): string | undefined {
  return MANIFEST.tierSystemPrompts[tier]
}
