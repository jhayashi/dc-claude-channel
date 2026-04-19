/**
 * Agent template library — pre-filled `AgentDef` starting points with an
 * `x-dc-template` metadata block describing the template itself
 * (category, user-facing description, required MCP servers).
 *
 * Templates ship as YAML files in `plugin/templates/*.yaml`. The loader
 * reads them once at startup and exposes a read-only `Template` view for
 * the agent-setup WebXDC picker. `instantiate()` produces a fresh
 * `DraftAgent` (id-less) with the template metadata stripped so it won't
 * leak into user-created agents.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { z } from 'zod'
import {
  AgentDefSchema,
  DraftAgentSchema,
  ARCHETYPES,
  type Archetype,
  type DraftAgent,
} from './agents.js'
import { ARCHETYPE_PALETTES, ARCHETYPE_DEFAULT_GLYPH } from './agent-icons/palettes.js'

/**
 * The `x-dc-template` metadata block embedded in a template YAML file.
 * Describes how the template appears in the picker UI and what external
 * dependencies it expects.
 */
export const TemplateMetaSchema = z.object({
  /** Picker category (drives section grouping). */
  category: z.enum(ARCHETYPES),
  /** Short human-readable blurb shown under the template tile. */
  description: z.string().min(1).max(256),
  /**
   * Optional dependencies that should be surfaced in the create flow.
   * `mcpServers` entries are prefixes (e.g., `claude_ai_Gmail`).
   */
  requires: z
    .object({
      mcpServers: z.array(z.string()).default([]),
    })
    .default({ mcpServers: [] }),
})

export type TemplateMeta = z.infer<typeof TemplateMetaSchema>

/**
 * Schema for a template YAML file: a full `AgentDef` plus a non-optional
 * `x-dc-template` block living inside `metadata`.
 */
const TemplateFileSchema = AgentDefSchema.extend({
  metadata: z
    .record(z.string(), z.unknown())
    .refine(
      m => m['x-dc-template'] != null,
      { message: "template YAML must contain metadata['x-dc-template']" },
    ),
})

/** View returned from `listTemplates` — normalized for the WebXDC picker. */
export interface Template {
  id: string
  name: string
  archetype: Archetype
  icon: string
  glyph: string
  model: string
  description: string
  requires: { mcpServers: string[] }
}

let TEMPLATES_DIR = join(import.meta.dir, 'templates')

/** Override the template directory (for tests). */
export function setTemplatesDir(dir: string): void {
  TEMPLATES_DIR = dir
}

/** Return the current templates directory (for tests). */
export function getTemplatesDir(): string {
  return TEMPLATES_DIR
}

/**
 * Read one template YAML from disk. Returns null if the file is missing,
 * unparseable, or fails schema validation. Invalid files are skipped
 * silently so a typo in one template doesn't break the whole picker.
 */
function readTemplate(path: string): { raw: z.infer<typeof TemplateFileSchema>; meta: TemplateMeta } | null {
  let raw: unknown
  try {
    raw = YAML.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
  const parsed = TemplateFileSchema.safeParse(raw)
  if (!parsed.success) return null
  const metaRaw = parsed.data.metadata!['x-dc-template']
  const meta = TemplateMetaSchema.safeParse(metaRaw)
  if (!meta.success) return null
  return { raw: parsed.data, meta: meta.data }
}

/**
 * List all templates shipped in `plugin/templates/`. Sorted alphabetically
 * by template id so section ordering in the UI is stable.
 */
export function listTemplates(): Template[] {
  let entries: string[] = []
  try {
    entries = readdirSync(TEMPLATES_DIR)
  } catch {
    return []
  }
  const out: Template[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.yaml')) continue
    const t = readTemplate(join(TEMPLATES_DIR, entry))
    if (!t) continue
    const meta = t.raw.metadata ?? {}
    const archetype = (ARCHETYPES as readonly string[]).includes(meta['x-dc-archetype'] as string)
      ? (meta['x-dc-archetype'] as Archetype)
      : t.meta.category
    const icon =
      typeof meta['x-dc-icon'] === 'string' && (meta['x-dc-icon'] as string).length > 0
        ? (meta['x-dc-icon'] as string)
        : defaultIconForCategory(archetype)
    const palette = ARCHETYPE_PALETTES[archetype] as readonly string[]
    const explicitGlyph = typeof meta['x-dc-glyph'] === 'string' ? (meta['x-dc-glyph'] as string) : ''
    const glyph = explicitGlyph && palette.includes(explicitGlyph)
      ? explicitGlyph
      : ARCHETYPE_DEFAULT_GLYPH[archetype]
    out.push({
      id: t.raw.id,
      name: t.raw.name,
      archetype,
      icon,
      glyph,
      model: t.raw.model,
      description: t.meta.description,
      requires: { mcpServers: t.meta.requires.mcpServers },
    })
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

function defaultIconForCategory(category: Archetype): string {
  return { role: '👤', utility: '⚙️', project: '📋' }[category]
}

/**
 * Instantiate a template as a `DraftAgent` (id-less). Strips the
 * `x-dc-template` metadata block so it won't leak onto the user's new
 * agent. Preserves `x-dc-archetype` and `x-dc-icon` since those are
 * legitimate agent fields. Returns null if the template id is unknown
 * or the file is invalid.
 */
export function instantiate(templateId: string): DraftAgent | null {
  let entries: string[] = []
  try {
    entries = readdirSync(TEMPLATES_DIR)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.endsWith('.yaml')) continue
    const t = readTemplate(join(TEMPLATES_DIR, entry))
    if (!t || t.raw.id !== templateId) continue
    // Strip id and x-dc-template while preserving other metadata.
    const { id: _id, ...rest } = t.raw
    const metadata = { ...(rest.metadata ?? {}) }
    delete metadata['x-dc-template']
    const cleaned = { ...rest, metadata: Object.keys(metadata).length > 0 ? metadata : undefined }
    const parsed = DraftAgentSchema.safeParse(cleaned)
    return parsed.success ? parsed.data : null
  }
  return null
}
