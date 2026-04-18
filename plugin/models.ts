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

export type ModelTier = 'opus' | 'sonnet' | 'haiku'

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

/** Tier bucket for icon/prompt lookups. Unknowns default to sonnet. */
export function tierForModel(id: string): ModelTier {
  return getModel(id)?.tier ?? 'sonnet'
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
