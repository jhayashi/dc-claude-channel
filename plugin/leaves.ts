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
 *
 * Task 8.A (catalog refactor): the loader now exposes an explicit
 * `Catalog` handle (built via `loadCatalog(dir)`) so callers that want
 * isolation — primarily tests running in parallel and the upcoming
 * Task 11.4 e2e harness — can construct their own catalog without
 * mutating module-global state. A lazy default singleton
 * (`getDefaultCatalog`) preserves the old module-level functions
 * (`loadAllLeaves`, `findLeaf`, etc.) for production callers that
 * should not have to thread a catalog through.
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

const DEFAULT_LEAVES_DIR = join(import.meta.dir, 'leaves')

/**
 * An immutable view over a directory of leaf YAML files. All accessor
 * methods return fresh copies / fresh queries — the underlying data is
 * computed once at load time and never mutated.
 */
export interface Catalog {
  /** All leaves in the catalog (fresh copy on every call). */
  all(): Leaf[]
  /** Lookup by id. Returns null if unknown. */
  findLeaf(id: string): Leaf | null
  /**
   * Group all leaves by path. Always returns all 3 keys
   * (Expert/Service/Goal), with empty arrays where applicable.
   */
  leavesByPath(): Record<Path, Leaf[]>
  /**
   * Group all leaves by L2 specialty. The returned Map only contains
   * keys for L2 strings actually observed in the catalog.
   */
  leavesByL2(): Map<string, Leaf[]>
  /** Bidirectional combines_with closure. */
  symmetricCombines(): Map<string, Set<string>>
}

/**
 * Build a fresh `Catalog` from a directory of YAML leaves.
 *
 * Always re-reads from disk on every call — there is no caching shared
 * between `Catalog` instances. (If you want caching for production
 * callers, use `getDefaultCatalog`.) Returns an empty catalog without
 * throwing when `dir` does not exist, matching the behavior of the
 * previous module-level loader.
 */
export function loadCatalog(dir: string = DEFAULT_LEAVES_DIR): Catalog {
  const leaves: Leaf[] = []
  const seen = new Map<string, string>() // id -> filename, for duplicate-error context

  if (existsSync(dir)) {
    const files = readdirSync(dir).filter(f => f.endsWith('.yaml'))
    for (const f of files) {
      const raw = YAML.parse(readFileSync(join(dir, f), 'utf-8'))
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

  // Compute symmetric closure once at load time.
  const sym = new Map<string, Set<string>>()
  for (const l of leaves) sym.set(l.id, new Set())
  for (const l of leaves) {
    for (const partner of l.combinesWith) {
      sym.get(l.id)?.add(partner)
      sym.get(partner)?.add(l.id)
    }
  }

  // Index by id for O(1) findLeaf.
  const byId = new Map<string, Leaf>()
  for (const l of leaves) byId.set(l.id, l)

  return {
    all() { return leaves.slice() },
    findLeaf(id: string) { return byId.get(id) ?? null },
    leavesByPath() {
      const out: Record<Path, Leaf[]> = { Expert: [], Service: [], Goal: [] }
      for (const l of leaves) out[l.path].push(l)
      return out
    },
    leavesByL2() {
      const out = new Map<string, Leaf[]>()
      for (const l of leaves) {
        if (!out.has(l.l2)) out.set(l.l2, [])
        out.get(l.l2)!.push(l)
      }
      return out
    },
    symmetricCombines() { return sym },
  }
}

// --- Default singleton (production convenience) -------------------

let defaultDir = DEFAULT_LEAVES_DIR
let defaultCatalog: Catalog | null = null

/**
 * Production-side accessor. Lazy-initialized on first access; reuses
 * the same instance until `setLeavesDir` resets it.
 */
export function getDefaultCatalog(): Catalog {
  if (!defaultCatalog) defaultCatalog = loadCatalog(defaultDir)
  return defaultCatalog
}

/**
 * Reset the default singleton. Tests that point at a temp leaves dir
 * use this — the next `getDefaultCatalog` call (or any module-level
 * delegating function) reloads from `dir`.
 */
export function setLeavesDir(dir: string): void {
  defaultDir = dir
  defaultCatalog = null
}

// --- Module-level convenience functions (delegate to default) -----

export function loadAllLeaves(): Leaf[] {
  return getDefaultCatalog().all()
}

export function findLeaf(id: string): Leaf | null {
  return getDefaultCatalog().findLeaf(id)
}

export function leavesByPath(): Record<Path, Leaf[]> {
  return getDefaultCatalog().leavesByPath()
}

export function leavesByL2(): Map<string, Leaf[]> {
  return getDefaultCatalog().leavesByL2()
}

export function symmetricCombines(): Map<string, Set<string>> {
  return getDefaultCatalog().symmetricCombines()
}
