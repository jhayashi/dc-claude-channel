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
