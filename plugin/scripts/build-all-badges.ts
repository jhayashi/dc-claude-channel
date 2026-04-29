/**
 * Pre-render every reachable agent badge PNG into
 * `plugin/agent-badges-prebuilt/` so the dispatcher can skip Resvg at
 * runtime. Runtime lookup is in agent-icon-render.ts; this script is
 * release-time only.
 *
 * The reachable matrix is small — the UI only exposes the 3
 * archetype-default glyphs (role/utility/project), 3 model color
 * families (haiku/sonnet/opus), and 2 trust states — so 18 files
 * total. Non-default glyphs (a future glyph-picker feature) fall
 * through to the live renderer.
 *
 * Run via `bun run build:badges` in `plugin/`.
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  renderAgentBadge,
  setBadgeCacheDir,
  type BadgeInputs,
} from '../agent-icon-render.js'
import {
  ARCHETYPE_DEFAULT_GLYPH,
  type ModelFamily,
} from '../agent-icons/palettes.js'

const OUT = join(import.meta.dir, '..', 'agent-badges-prebuilt')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
setBadgeCacheDir(OUT)

const archetypes = ['role', 'utility', 'project'] as const
const models: ModelFamily[] = ['haiku', 'sonnet', 'opus']
const trusts = [false, true]

let count = 0
for (const archetype of archetypes) {
  const glyph = ARCHETYPE_DEFAULT_GLYPH[archetype]
  for (const modelFamily of models) {
    for (const trust of trusts) {
      // Prebuild only the legacy 'checker' variant. Other patterns are
      // user-pickable and small enough to render on demand at runtime
      // (the cache eliminates the repeat cost). Adding all 8 here would
      // 8x the prebuilt PNG count for a feature most users never tweak.
      const inputs: BadgeInputs = { archetype, modelFamily, trust, glyph, pattern: 'checker' }
      const path = await renderAgentBadge(inputs)
      console.log(`built ${path}`)
      count++
    }
  }
}
console.log(`\n${count} badges rendered to ${OUT}`)
