/**
 * v1.3 → v1.4 agent definition migration.
 *
 * v1.3 layout: ~/.claude/channels/deltachat/agents/<id>/definition.yaml
 *   - YAML with `id`, `name` (display), `system`, `tools: []`,
 *     `metadata: { x-dc-* }`, `allowedBuiltinTools`, `allowedMcpServers`.
 *
 * v1.4 layout: ~/.claude/agents/<name>.md
 *   - Markdown body (system prompt) + YAML frontmatter (CC schema +
 *     x-dc-* extensions). See docs/superpowers/specs/2026-05-16-cc-
 *     agent-compatibility-design.md §2.
 *
 * This module exposes:
 *   - `LegacyAgentDef` / `LegacyAgentDefSchema` — the v1.3 shape (kept
 *     local; not exported from agents.ts).
 *   - `mapLegacyToNew(legacy)` — pure schema mapping.
 *   - `migrateLegacyDefinitionYaml()` — disk-touching one-shot.
 */

import { z } from 'zod'
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import YAML from 'yaml'
import * as agents from './agents.js'
import { ALL_BUILTIN_TOOLS } from './dispatcher/subagent-process.js'

export const LegacyAgentDefSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  description: z.string().default(''),
  system: z.string().default(''),
  tools: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedBuiltinTools: z.array(z.string()).nullable().optional(),
  allowedMcpServers: z.array(z.string()).nullable().optional(),
  allowedMcpTools: z.array(z.string()).nullable().optional(),
  effort: z.string().optional(),
})

export type LegacyAgentDef = z.infer<typeof LegacyAgentDefSchema>

const X_DC_METADATA_RENAMES: Record<string, string> = {
  'x-dc-icon': 'x-dc-icon',
  'x-dc-glyph': 'x-dc-glyph',
  'x-dc-pattern': 'x-dc-pattern',
  'x-dc-archetype': 'x-dc-archetype',
  'x-dc-iconMirror': 'x-dc-icon-mirror', // camelCase → kebab-case
}

// Subagent-spawn built-ins. Excluded from the default tools CSV per §6.3
// (nested subagent dispatch is forbidden / undefined for DC's lifecycle).
// `Agent` is a deprecated alias for `Task`; only `Task`/`TaskOutput`/`TaskStop`
// appear in ALL_BUILTIN_TOOLS today, so listing those here is sufficient.
const SPAWN_TOOLS = new Set(['Agent', 'Task', 'TaskOutput', 'TaskStop'])

/** Pure schema mapping from v1.3 legacy shape to v1.4 CC frontmatter shape. */
export function mapLegacyToNew(src: LegacyAgentDef): agents.AgentDef {
  // Tools: collapse the parallel built-in/MCP allowlists into one CSV.
  const builtins = src.allowedBuiltinTools ?? ALL_BUILTIN_TOOLS.filter(t => !SPAWN_TOOLS.has(t))
  const mcpServers = (src.allowedMcpServers ?? []).slice()
  // Legacy allowedMcpTools (per-tool) collapsed to dc-server if non-empty.
  if ((src.allowedMcpTools ?? []).length > 0 && !mcpServers.includes('dc')) {
    mcpServers.push('dc')
  }
  if (!mcpServers.includes('dc')) mcpServers.push('dc')
  const tools = [
    ...builtins,
    ...mcpServers.map(s => `mcp__${s}`),
  ].join(', ')

  // Metadata: promote x-dc-* to top-level, rename iconMirror → icon-mirror,
  // map x-dc-skipPermissions → permissionMode.
  const out: Record<string, unknown> = {
    name: src.id,
    description: src.description,
    model: src.model,
    tools,
    memory: 'user' as const,
    body: src.system,
  }
  if (src.effort) out.effort = src.effort

  const meta = src.metadata ?? {}
  if (meta['x-dc-skipPermissions'] === true) {
    out.permissionMode = 'bypassPermissions'
  }
  for (const [legacyKey, newKey] of Object.entries(X_DC_METADATA_RENAMES)) {
    if (meta[legacyKey] !== undefined) out[newKey] = meta[legacyKey]
  }

  // Display-name extension — preserve the human name only when it
  // genuinely differs from the slug.
  if (src.name && src.name !== src.id) {
    out['x-dc-display-name'] = src.name
  }

  // Validate the produced object against the new schema.
  return agents.AgentDefSchema.parse(out)
}

let LEGACY_AGENTS_DIR = join(homedir(), '.claude', 'channels', 'deltachat', 'agents')

/** Override the legacy agents dir (for tests). */
export function setLegacyAgentsDir(dir: string): void {
  LEGACY_AGENTS_DIR = dir
}

export interface MigrationResult {
  /** Number of agents successfully migrated this run. */
  migrated: number
  /** Names that collided with an existing target file; their migrated copy was written with `-dc` suffix. */
  collisions: string[]
}

/**
 * One-shot migration from v1.3 layout to v1.4 layout. Idempotent: a
 * second invocation finds the legacy dir gone (renamed to `*.legacy`)
 * and no-ops. Non-destructive: never overwrites an existing v1.4 file;
 * collisions write with a `-dc` suffix and append the name to the
 * result's `collisions` list for the caller to log.
 */
export function migrateLegacyDefinitionYaml(): MigrationResult {
  const result: MigrationResult = { migrated: 0, collisions: [] }
  if (!existsSync(LEGACY_AGENTS_DIR)) return result

  let entries: string[]
  try {
    entries = readdirSync(LEGACY_AGENTS_DIR)
  } catch {
    return result
  }

  for (const entry of entries) {
    const dirPath = join(LEGACY_AGENTS_DIR, entry)
    let isDir = false
    try { isDir = statSync(dirPath).isDirectory() } catch { continue }
    if (!isDir) continue

    const defPath = join(dirPath, 'definition.yaml')
    if (!existsSync(defPath)) continue

    let raw: unknown
    try { raw = YAML.parse(readFileSync(defPath, 'utf-8')) } catch (err) {
      console.error(`migrate v1.4: cannot parse ${defPath}:`, err)
      continue
    }
    const parsed = LegacyAgentDefSchema.safeParse(raw)
    if (!parsed.success) {
      console.error(`migrate v1.4: invalid legacy schema in ${defPath}:`, parsed.error.message)
      continue
    }

    let newDef: agents.AgentDef
    try {
      newDef = mapLegacyToNew(parsed.data)
    } catch (err) {
      console.error(`migrate v1.4: schema mapping failed for ${defPath}:`, err)
      continue
    }

    // Collision: target file already exists → suffix with -dc.
    const targetExists = agents.getAgent(newDef.name) !== null
    if (targetExists) {
      result.collisions.push(newDef.name)
      const base = newDef.name
      let n = 0
      let suffix = `${base}-dc`
      while (agents.getAgent(suffix)) {
        n++
        suffix = `${base}-dc${n}`
      }
      newDef = { ...newDef, name: suffix }
    }

    try {
      agents.saveAgent(newDef)
    } catch (err) {
      console.error(`migrate v1.4: saveAgent failed for ${newDef.name}:`, err)
      continue
    }

    // Move contacts dir if present.
    const legacyContacts = join(dirPath, 'contacts')
    if (existsSync(legacyContacts)) {
      const newContactsParent = join(agents.getAgentsDir(), `${newDef.name}.dc`)
      const newContacts = join(newContactsParent, 'contacts')
      try {
        mkdirSync(newContactsParent, { recursive: true })
        renameSync(legacyContacts, newContacts)
      } catch (err) {
        console.error(`migrate v1.4: contacts move failed for ${newDef.name}:`, err)
      }
    }

    result.migrated++
  }

  // Retire the legacy directory once we've walked everything — even if
  // some entries failed (they're logged; operator can recover from
  // `agents.legacy/` if needed).
  try {
    const legacyTarget = `${LEGACY_AGENTS_DIR}.legacy`
    if (existsSync(legacyTarget)) {
      console.error(`migrate v1.4: ${legacyTarget} already exists; leaving ${LEGACY_AGENTS_DIR} in place for manual inspection`)
    } else {
      renameSync(LEGACY_AGENTS_DIR, legacyTarget)
    }
  } catch (err) {
    console.error(`migrate v1.4: legacy dir retire failed:`, err)
  }

  return result
}
