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
