/**
 * Agent template library — pre-filled `AgentDef` starting points carrying
 * an `x-dc-template` top-level frontmatter block describing the template
 * itself (category, user-facing description, required MCP servers).
 *
 * Templates ship as YAML files in `plugin/templates/*.yaml` in v1.4 layout:
 * the same shape as an agent .md frontmatter, just stored as one YAML
 * document with the `body` field carrying the system prompt. The loader
 * exposes a read-only `Template` view for the agent-setup WebXDC picker.
 * `instantiate()` produces a fresh `DraftAgent` (name-less) with the
 * template-only `x-dc-template` block stripped so it doesn't leak into
 * user-created agents.
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
 * The `x-dc-template` frontmatter block embedded in a template YAML.
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
 * Schema for a template YAML file: a full `AgentDef` plus a required
 * top-level `x-dc-template` field.
 */
const TemplateFileSchema = AgentDefSchema.extend({
  'x-dc-template': z.unknown().refine(v => v != null, {
    message: 'template YAML must contain x-dc-template',
  }),
})

/** View returned from `listTemplates` — normalized for the WebXDC picker. */
export interface Template {
  name: string
  displayName: string
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
  const meta = TemplateMetaSchema.safeParse(parsed.data['x-dc-template'])
  if (!meta.success) return null
  return { raw: parsed.data, meta: meta.data }
}

/**
 * List all templates shipped in `plugin/templates/`. Sorted alphabetically
 * by template name so section ordering in the UI is stable.
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
    const raw = t.raw
    const archetype = (ARCHETYPES as readonly string[]).includes(raw['x-dc-archetype'] as string)
      ? (raw['x-dc-archetype'] as Archetype)
      : t.meta.category
    const icon =
      typeof raw['x-dc-icon'] === 'string' && (raw['x-dc-icon'] as string).length > 0
        ? (raw['x-dc-icon'] as string)
        : defaultIconForCategory(archetype)
    const palette = ARCHETYPE_PALETTES[archetype] as readonly string[]
    const explicitGlyph = typeof raw['x-dc-glyph'] === 'string' ? (raw['x-dc-glyph'] as string) : ''
    const glyph = explicitGlyph && palette.includes(explicitGlyph)
      ? explicitGlyph
      : ARCHETYPE_DEFAULT_GLYPH[archetype]
    const displayName =
      typeof raw['x-dc-display-name'] === 'string' && (raw['x-dc-display-name'] as string).length > 0
        ? (raw['x-dc-display-name'] as string)
        : raw.name
    out.push({
      name: raw.name,
      displayName,
      archetype,
      icon,
      glyph,
      model: raw.model,
      description: t.meta.description,
      requires: { mcpServers: t.meta.requires.mcpServers },
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function defaultIconForCategory(category: Archetype): string {
  return { role: '👤', utility: '⚙️', project: '📋' }[category]
}

/**
 * Instantiate a template as a `DraftAgent` (name-less). Strips the
 * `x-dc-template` block so it won't leak onto the user's new agent.
 * Preserves `x-dc-archetype` / `x-dc-icon` since those are legitimate
 * agent fields. Returns null if the template name is unknown or the file
 * is invalid.
 */
export function instantiate(templateName: string): DraftAgent | null {
  let entries: string[] = []
  try {
    entries = readdirSync(TEMPLATES_DIR)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.endsWith('.yaml')) continue
    const t = readTemplate(join(TEMPLATES_DIR, entry))
    if (!t || t.raw.name !== templateName) continue
    const { name: _name, 'x-dc-template': _meta, ...rest } = t.raw
    const parsed = DraftAgentSchema.safeParse(rest)
    return parsed.success ? parsed.data : null
  }
  return null
}
