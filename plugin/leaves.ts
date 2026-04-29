/**
 * Leaf catalog schema — atomic units the user picks when building an
 * agent. Each leaf is authored as a YAML file (one per leaf) under the
 * catalog directory; this module defines the shape every such file must
 * conform to.
 *
 * Subsequent tasks layer on top of this schema:
 *   - 1.2 loader: reads YAML files, caches them, computes the symmetric
 *     closure of `combinesWith` (one-way authoring, two-way runtime).
 *   - 1.3 export-from-CSV: bulk-converts the authored CSV catalog into
 *     individual leaf YAML files.
 */

import { z } from 'zod'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

/**
 * The three top-level paths a leaf belongs to. An agent is built by
 * picking leaves along one of these paths. Authored values outside this
 * set are rejected at load time.
 */
export const PATHS = ['Expert', 'Service', 'Goal'] as const
export type Path = (typeof PATHS)[number]

/**
 * Leaves that touch regulated or otherwise sensitive domains carry a
 * liability flag so the agent-creation flow can surface the appropriate
 * disclaimer / friction. `null` (the default) means the leaf has no
 * special liability concern.
 */
export const LIABILITY_FLAGS = [
  'medical',
  'legal',
  'financial-investment',
  'tax',
  'immigration',
  'veterinary',
  'religious-authority',
  'eldercare',
  'mental-health',
] as const
export type LiabilityFlag = (typeof LIABILITY_FLAGS)[number]

/**
 * Shape of one authored leaf YAML file. Defaults are applied so the
 * loader (Task 1.2) can rely on `parameter`, `liability`,
 * `combinesWith`, and `suggestedTools` always being present after parse.
 */
export const LeafSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'leaf id must be kebab-case'),
  path: z.enum(PATHS),
  l2: z.string().min(1),
  name: z.string().min(1),
  parameter: z.string().nullable().default(null),
  liability: z.enum(LIABILITY_FLAGS).nullable().default(null),
  pitch: z.string().min(1).max(400),
  expertise: z.string().min(1).max(800),
  combinesWith: z.array(z.string()).default([]),
  suggestedTools: z.array(z.string()).default([]),
})

export type Leaf = z.infer<typeof LeafSchema>

let LEAVES_DIR = join(import.meta.dir, 'leaves')
let CACHE: { leaves: Leaf[]; sym: Map<string, Set<string>> } | null = null

export function setLeavesDir(dir: string): void {
  LEAVES_DIR = dir
  CACHE = null
}

export function loadAllLeaves(): Leaf[] {
  if (CACHE) return CACHE.leaves
  if (!existsSync(LEAVES_DIR)) {
    CACHE = { leaves: [], sym: new Map() }
    return CACHE.leaves
  }
  const files = readdirSync(LEAVES_DIR).filter(f => f.endsWith('.yaml'))
  const leaves: Leaf[] = []
  const seen = new Map<string, string>() // id -> filename, for duplicate-error context
  for (const f of files) {
    const raw = YAML.parse(readFileSync(join(LEAVES_DIR, f), 'utf-8'))
    let parsed: Leaf
    try {
      parsed = LeafSchema.parse(raw)
    } catch (e) {
      throw new Error(`leaves/${f}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (seen.has(parsed.id)) {
      throw new Error(`duplicate leaf id: ${parsed.id} (in ${seen.get(parsed.id)} and ${f})`)
    }
    seen.set(parsed.id, f)
    leaves.push(parsed)
  }
  // Validate combinesWith references resolve to known leaves.
  const knownIds = new Set(leaves.map(l => l.id))
  for (const l of leaves) {
    for (const partner of l.combinesWith) {
      if (!knownIds.has(partner)) {
        throw new Error(`leaves/${l.id}.yaml: combinesWith references unknown leaf "${partner}"`)
      }
    }
  }
  const sym = computeSymmetricClosure(leaves)
  CACHE = { leaves, sym }
  return leaves
}

function computeSymmetricClosure(leaves: Leaf[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const l of leaves) out.set(l.id, new Set())
  for (const l of leaves) {
    for (const partner of l.combinesWith) {
      out.get(l.id)?.add(partner)
      out.get(partner)?.add(l.id)
    }
  }
  return out
}

export function symmetricCombines(): Map<string, Set<string>> {
  loadAllLeaves()
  return CACHE!.sym
}

export function findLeaf(id: string): Leaf | null {
  return loadAllLeaves().find(l => l.id === id) ?? null
}

export function leavesByPath(): Record<Path, Leaf[]> {
  const out: Record<Path, Leaf[]> = { Expert: [], Service: [], Goal: [] }
  for (const l of loadAllLeaves()) out[l.path].push(l)
  return out
}

export function leavesByL2(): Map<string, Leaf[]> {
  const out = new Map<string, Leaf[]>()
  for (const l of loadAllLeaves()) {
    if (!out.has(l.l2)) out.set(l.l2, [])
    out.get(l.l2)!.push(l)
  }
  return out
}
