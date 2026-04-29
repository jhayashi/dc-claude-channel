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
  if (!existsSync(LEAVES_DIR)) return []
  const files = readdirSync(LEAVES_DIR).filter(f => f.endsWith('.yaml'))
  const leaves: Leaf[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const raw = YAML.parse(readFileSync(join(LEAVES_DIR, f), 'utf-8'))
    const parsed = LeafSchema.parse(raw)
    if (seen.has(parsed.id)) {
      throw new Error(`duplicate leaf id: ${parsed.id}`)
    }
    seen.add(parsed.id)
    leaves.push(parsed)
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
