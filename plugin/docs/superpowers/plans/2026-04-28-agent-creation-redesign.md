# Agent Creation Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current template-grid agent-creation flow with an ontology-driven wall + mash-up + coach-led interview, add in-chat NL controls (model switch, trust toggle, refine), expand the badge to 8 pattern variants on a single glyph, and add the Refine card + grouped-home IA. Spec: `plugin/docs/superpowers/specs/2026-04-28-agent-creation-redesign-design.md`.

**Architecture:** Five new pure-function modules (catalog loader, personality presets, liability frames, system-prompt assembler, coach state machine) compose into the existing dispatcher. UI lives in `plugin/webxdc/agent-setup.html` extended with the wall + mash-up overlay. Coach interview runs in the new chat as the first persona of the agent's session; graduation is a soft system-prompt swap with a visible badge change. NL intent classification adds three handlers to the dispatcher's per-turn pipeline. Badges add seven SVG pattern functions to the existing renderer. No migration: existing v1.x agents and templates coexist by sitting where they sit.

**Tech Stack:** TypeScript / Bun, existing WebXDC + agent-icon-render + bindings infrastructure. New deps: none. YAML schema reuses Zod patterns from `agents.ts`. Tests via Bun's test runner; UI tests via the Tier-1 Playwright harness in `plugin/test/webxdc/`.

**Phasing:** Eleven phases, each shippable. Phase 1–4 are foundation modules; phase 5–7 are the user-visible new flow; phase 8 is the badge work; phase 9 is NL controls; phase 10 is Refine + home IA; phase 11 is end-to-end testing and deprecation cleanup. After each phase the new code is wired into a feature flag (`DC_NEW_AGENT_FLOW=1`) until phase 11 makes it the default.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `plugin/leaves.ts` | Leaf catalog loader, schema, query helpers | Create |
| `plugin/leaves/*.yaml` | 155 leaf YAML files (one per leaf) | Create (via export script) |
| `plugin/leaves-export.ts` | One-off export script: CSV → YAML files | Create |
| `plugin/personality-presets.ts` | Five preset snippets + slider modifiers | Create |
| `plugin/liability-frames.ts` | Nine non-advisory snippets keyed by flag | Create |
| `plugin/prompt-assembler.ts` | Compose five-paragraph system prompt from inputs | Create |
| `plugin/coach.ts` | Coach state machine: per-leaf-shape interview script | Create |
| `plugin/nl-intents.ts` | Intent classifier + handlers (model / trust / refine) | Create |
| `plugin/agent-icons/palettes.ts` | Add `pattern` field to palettes | Modify |
| `plugin/agent-icon-render.ts` | Add 7 pattern SVG builders + pattern-aware cache key | Modify |
| `plugin/webxdc/agent-setup.html` | Wall, mash-up overlay, Refine entry, group divider | Modify (heavy) |
| `plugin/apps/agent-setup-app.ts` | Wire wall data, build pill state, coach handoff | Modify (heavy) |
| `plugin/server.ts` | Hook NL intents into per-turn pipeline | Modify (small) |
| `plugin/agents.ts` | Add new metadata field helpers | Modify (small) |
| `plugin/test/leaves.test.ts` | Loader + query tests | Create |
| `plugin/test/personality-presets.test.ts` | Preset rendering tests | Create |
| `plugin/test/liability-frames.test.ts` | Liability lookup tests | Create |
| `plugin/test/prompt-assembler.test.ts` | Composition tests (single + mash-up) | Create |
| `plugin/test/coach.test.ts` | Coach state machine tests | Create |
| `plugin/test/nl-intents.test.ts` | Intent classifier tests | Create |
| `plugin/test/badge-patterns.test.ts` | Pattern SVG snapshot tests | Create |
| `plugin/test/webxdc/agent-setup-wall.test.ts` | Playwright UI tests for wall | Create |
| `plugin/test/agent-creation-e2e.test.ts` | End-to-end happy path | Create |

---

## Phase 1: Catalog (data + loader)

### Task 1.1: Define the leaf YAML schema

**Files:**
- Create: `plugin/leaves.ts`
- Create: `plugin/test/leaves.test.ts`

- [ ] **Step 1: Write the failing schema test**

Create `plugin/test/leaves.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { LeafSchema, type Leaf } from '../leaves.js'

describe('LeafSchema', () => {
  test('parses a minimal leaf', () => {
    const raw = {
      id: 'sleep-coach',
      path: 'Expert',
      l2: 'Health, wellness, caregiving',
      name: 'Sleep coach',
      pitch: 'Diagnoses your sleep with you, designs a sleep-hygiene plan, and tracks results. Can monitor your tracker data and surface what changed week-over-week.',
      expertise: 'As a sleep coach, build and maintain a sleep-hygiene plan with the user; read tracker data weekly and surface what changed.',
    }
    const parsed = LeafSchema.parse(raw)
    expect(parsed.id).toBe('sleep-coach')
    expect(parsed.path).toBe('Expert')
    expect(parsed.parameter).toBeNull()
    expect(parsed.liability).toBeNull()
    expect(parsed.combinesWith).toEqual([])
    expect(parsed.suggestedTools).toEqual([])
  })

  test('parses a fully-populated leaf', () => {
    const raw = {
      id: 'tutor',
      path: 'Expert',
      l2: 'Education',
      name: 'Tutor',
      parameter: 'subject',
      liability: null,
      pitch: 'Teaches a subject from where you actually are. Tracks what you have mastered.',
      expertise: 'As a tutor, teach from where the learner is. Diagnose gaps before reteaching.',
      combinesWith: ['test-prep-coach', 'writing-coach', 'education-milestone'],
      suggestedTools: ['gmail'],
    }
    const parsed = LeafSchema.parse(raw)
    expect(parsed.parameter).toBe('subject')
    expect(parsed.combinesWith).toHaveLength(3)
  })

  test('rejects unknown path', () => {
    expect(() =>
      LeafSchema.parse({ id: 'x', path: 'Other', l2: 'X', name: 'X', pitch: 'X', expertise: 'X' })
    ).toThrow()
  })

  test('rejects unknown liability flag', () => {
    expect(() =>
      LeafSchema.parse({ id: 'x', path: 'Expert', l2: 'X', name: 'X', pitch: 'X', expertise: 'X', liability: 'fishery' })
    ).toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd plugin && bun test test/leaves.test.ts
```

Expected: FAIL with `Cannot find module '../leaves.js'`.

- [ ] **Step 3: Write the schema and types**

Create `plugin/leaves.ts`:

```typescript
import { z } from 'zod'

export const PATHS = ['Expert', 'Service', 'Goal'] as const
export type Path = (typeof PATHS)[number]

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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd plugin && bun test test/leaves.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/leaves.ts plugin/test/leaves.test.ts
git commit -m "feat(leaves): leaf catalog schema"
```

### Task 1.2: Add the loader with caching and queries

**Files:**
- Modify: `plugin/leaves.ts`
- Modify: `plugin/test/leaves.test.ts`

- [ ] **Step 1: Add the loader test**

Append to `plugin/test/leaves.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadAllLeaves,
  setLeavesDir,
  findLeaf,
  leavesByPath,
  leavesByL2,
  symmetricCombines,
} from '../leaves.js'

describe('Leaves loader', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'leaves-test-'))
    setLeavesDir(tmpDir)
  })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  function writeLeaf(yaml: string, name: string) {
    writeFileSync(join(tmpDir, `${name}.yaml`), yaml)
  }

  test('loads multiple leaves', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\n`, 'a')
    writeLeaf(`id: b\npath: Service\nl2: Service\nname: B\npitch: b\nexpertise: b\n`, 'b')
    const all = loadAllLeaves()
    expect(all).toHaveLength(2)
  })

  test('findLeaf returns by id', () => {
    writeLeaf(`id: tutor\npath: Expert\nl2: Education\nname: Tutor\nparameter: subject\npitch: t\nexpertise: t\n`, 'tutor')
    const found = findLeaf('tutor')
    expect(found?.name).toBe('Tutor')
    expect(findLeaf('missing')).toBeNull()
  })

  test('symmetric closure adds reverse edges', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\ncombinesWith: [b]\n`, 'a')
    writeLeaf(`id: b\npath: Expert\nl2: X\nname: B\npitch: b\nexpertise: b\n`, 'b')
    const sym = symmetricCombines()
    expect(sym.get('a')).toEqual(new Set(['b']))
    expect(sym.get('b')).toEqual(new Set(['a']))
  })

  test('leavesByPath groups correctly', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\n`, 'a')
    writeLeaf(`id: b\npath: Service\nl2: Service\nname: B\npitch: b\nexpertise: b\n`, 'b')
    const groups = leavesByPath()
    expect(groups.Expert).toHaveLength(1)
    expect(groups.Service).toHaveLength(1)
    expect(groups.Goal).toHaveLength(0)
  })

  test('rejects duplicate id', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\n`, 'a')
    writeLeaf(`id: a\npath: Service\nl2: Service\nname: A2\npitch: x\nexpertise: x\n`, 'a2')
    expect(() => loadAllLeaves()).toThrow(/duplicate leaf id/)
  })
})
```

- [ ] **Step 2: Run to verify failures**

```bash
cd plugin && bun test test/leaves.test.ts
```

Expected: FAIL — loader exports not found.

- [ ] **Step 3: Implement the loader**

Append to `plugin/leaves.ts`:

```typescript
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

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
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/leaves.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/leaves.ts plugin/test/leaves.test.ts
git commit -m "feat(leaves): loader, cache, symmetric closure, queries"
```

### Task 1.3: Write the export script (CSV → YAML files)

**Files:**
- Create: `plugin/leaves-export.ts`

- [ ] **Step 1: Write the export script**

Create `plugin/leaves-export.ts`:

```typescript
/**
 * One-off export: read the v0.4.1 catalog CSV (path, l2_domain, leaf,
 * parameter, liability, combines_with, pitch, notes), emit one YAML file
 * per leaf into plugin/leaves/. Run with: bun run plugin/leaves-export.ts <csv-path>
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function parseCsv(text: string): Record<string, string>[] {
  // Very small CSV parser; handles quoted fields with commas + escaped quotes.
  const rows: string[][] = []
  let cur: string[] = []
  let field = ''
  let inQuote = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuote) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++ }
      else if (c === '"') { inQuote = false }
      else { field += c }
    } else {
      if (c === '"') inQuote = true
      else if (c === ',') { cur.push(field); field = '' }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = '' }
      else if (c === '\r') { /* skip */ }
      else { field += c }
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur) }
  const [header, ...data] = rows
  return data.filter(r => r.some(c => c.trim())).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

const csvPath = process.argv[2]
if (!csvPath) {
  console.error('usage: bun run plugin/leaves-export.ts <csv-path>')
  process.exit(2)
}

const text = readFileSync(csvPath, 'utf-8')
const rows = parseCsv(text)

const outDir = join(import.meta.dir, 'leaves')
mkdirSync(outDir, { recursive: true })

const seen = new Set<string>()
let written = 0
for (const r of rows) {
  const id = slugify(r.leaf || '')
  if (!id) continue
  if (seen.has(id)) {
    console.error(`duplicate slug: ${id} for "${r.leaf}"`)
    process.exit(1)
  }
  seen.add(id)

  const partners = (r.combines_with || '').split(';').map(s => s.trim()).filter(Boolean).map(slugify)

  const leaf: Record<string, unknown> = {
    id,
    path: r.path,
    l2: r.l2_domain,
    name: r.leaf,
    pitch: r.pitch,
    expertise: r.pitch, // Bootstrap: use pitch as expertise placeholder; will be hand-tuned in Phase 2
  }
  if (r.parameter) leaf.parameter = r.parameter
  if (r.liability) leaf.liability = r.liability
  if (partners.length) leaf.combinesWith = partners

  writeFileSync(join(outDir, `${id}.yaml`), YAML.stringify(leaf))
  written++
}
console.log(`wrote ${written} leaves to ${outDir}`)
```

- [ ] **Step 2: Run the export against the v0.4.1 CSV**

The current source-of-truth CSV is at `/tmp/agent-ontology-v0.4.csv` (155 rows after the Knowledge worker append; bidirectional pairs applied at runtime by the loader).

```bash
cd plugin && bun run leaves-export.ts /tmp/agent-ontology-v0.4.csv
ls leaves/ | wc -l
```

Expected: 155 (or 154 if Knowledge worker isn't in the CSV — re-export from the live Sheet via `gog sheets export ... --format csv` if needed).

- [ ] **Step 3: Verify the loader can parse all of them**

```bash
cd plugin && bun -e 'import("./leaves.js").then(m => { const all = m.loadAllLeaves(); console.log(all.length, "leaves loaded"); })'
```

Expected: `155 leaves loaded` (or 154).

- [ ] **Step 4: Commit the export script + the generated YAML files**

```bash
git add -f plugin/leaves-export.ts plugin/leaves/
git commit -m "feat(leaves): export 155-leaf catalog from v0.4.1 CSV"
```

(force-add because of the repo's `docs/` ignore rule which can also catch the leaves dir if a future glob shifts).

---

## Phase 2: Authoring per-leaf expertise paragraphs

The export script bootstraps `expertise` with `pitch`. That works as a placeholder but the real `expertise` paragraph needs to encode the leaf's domain knowledge — the part that drives how the agent thinks. This phase is the catalog-author's pass over each leaf to write the genuine expertise paragraph.

### Task 2.1: Establish the authoring pattern with a single example

**Files:**
- Modify: `plugin/leaves/sleep-coach.yaml`
- Modify: `plugin/test/leaves.test.ts`

- [ ] **Step 1: Add a test that asserts expertise differs from pitch**

Append to `plugin/test/leaves.test.ts`:

```typescript
describe('Catalog authoring (real data)', () => {
  test('Sleep coach has authored expertise paragraph distinct from pitch', () => {
    setLeavesDir(join(import.meta.dir, '..', 'leaves'))
    const sleep = findLeaf('sleep-coach')
    expect(sleep).not.toBeNull()
    expect(sleep!.expertise).not.toBe(sleep!.pitch)
    expect(sleep!.expertise.length).toBeGreaterThan(50)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd plugin && bun test test/leaves.test.ts -t "authored expertise"
```

Expected: FAIL — expertise === pitch from the bootstrap.

- [ ] **Step 3: Author the real expertise paragraph for Sleep coach**

Edit `plugin/leaves/sleep-coach.yaml`:

```yaml
id: sleep-coach
path: Expert
l2: Health, wellness, caregiving
name: Sleep coach
liability: medical
pitch: Diagnoses your sleep with you, designs a sleep-hygiene plan, and tracks results. Can monitor your tracker data and surface what changed week-over-week.
expertise: |
  As a sleep coach, your job is to help the user understand and improve
  their sleep. Diagnose patterns before prescribing changes. Read tracker
  data (Oura, Apple Watch, Whoop, manual logs) longitudinally — single
  bad nights aren't signal. Distinguish between sleep hygiene (caffeine,
  light, room temp), sleep timing (chronotype, schedule consistency),
  and sleep architecture (REM, deep) and explain which lever a given
  problem responds to. When stress, alcohol, or screen time appear
  upstream of poor nights, name them but don't moralize. You are
  non-clinical — defer to a sleep medicine specialist for sustained
  symptoms beyond two weeks or signs of sleep apnea, restless legs,
  parasomnia, etc.
combinesWith:
  - stress-management-coach
  - mindfulness-meditation-guide
  - nutrition-partner
  - fitness-goal-partner
  - mental-health-peer-support-buddy
  - health-metric-tracker
  - yoga-movement-partner
suggestedTools:
  - apple-health
  - oura
```

- [ ] **Step 4: Re-run the test**

```bash
cd plugin && bun test test/leaves.test.ts -t "authored expertise"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/leaves/sleep-coach.yaml plugin/test/leaves.test.ts
git commit -m "feat(leaves): author Sleep coach expertise paragraph"
```

### Task 2.2: Author all remaining 154 leaves

**Note for the agentic worker:** This is real, hand-curated authoring work. Do not generate placeholders. For each leaf, write a 4-10 sentence `expertise` paragraph that:
1. Names the agent's role explicitly ("As a tutor, your job is to...").
2. Captures the actual *how* of the work (diagnose-then-prescribe; tools-of-the-trade vocabulary; what-to-do-when-stuck).
3. For liability-flagged leaves, includes the non-advisory caveat *embedded in the prose*, not appended.
4. Avoids generic LLM-helper phrasing ("I can help you with X"). Prefer an apprentice's voice ("As an X, you...").

A reasonable batching strategy for an agentic worker:
- Read 5 leaves of the same L2 specialty at once (so they speak with consistent vocabulary).
- Author them as a group.
- Run the loader test after each L2 group.
- Commit per-L2 group.

- [ ] **Step 1: Inventory the leaves needing authoring**

```bash
cd plugin && bun -e 'import("./leaves.js").then(async m => {
  const all = m.loadAllLeaves();
  const todo = all.filter(l => l.expertise === l.pitch);
  console.log(`${todo.length} leaves still using pitch as expertise`);
  // Group by l2
  const groups = new Map();
  for (const l of todo) {
    if (!groups.has(l.l2)) groups.set(l.l2, []);
    groups.get(l.l2).push(l.name);
  }
  for (const [l2, names] of [...groups.entries()].sort()) {
    console.log(`  ${l2}: ${names.length}`);
  }
})'
```

Expected: prints the remaining 154 grouped by L2.

- [ ] **Step 2-N: Author each L2 group, one commit per group**

For each L2 in the inventory, edit each leaf YAML, run `bun test test/leaves.test.ts`, commit:

```bash
git add plugin/leaves/<group>*.yaml
git commit -m "feat(leaves): author <l2-name> expertise paragraphs"
```

Continue until `todo.length === 0`. Final commit:

```bash
git commit --allow-empty -m "feat(leaves): all 155 expertise paragraphs authored"
```

---

## Phase 3: Personality presets + liability frames (static text modules)

### Task 3.1: Personality presets module

**Files:**
- Create: `plugin/personality-presets.ts`
- Create: `plugin/test/personality-presets.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugin/test/personality-presets.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import {
  PRESETS,
  renderVoice,
  type PresetId,
  type SliderState,
} from '../personality-presets.js'

describe('Personality presets', () => {
  test('exports five presets', () => {
    expect(Object.keys(PRESETS)).toEqual(['coach', 'drill-sergeant', 'mentor', 'pal', 'professor'])
  })

  test('renderVoice with bare preset returns the preset snippet', () => {
    const v = renderVoice('drill-sergeant', {})
    expect(v).toContain('Drill Sergeant')
    expect(v).toContain('Terse')
  })

  test('renderVoice applies Educator Socratic↔Direct slider', () => {
    const directV = renderVoice('mentor', { socratic: 'direct' } as SliderState)
    expect(directV).toContain('Direct')

    const socraticV = renderVoice('mentor', { socratic: 'socratic' } as SliderState)
    expect(socraticV).toContain('Socratic')
  })

  test('renderVoice ignores unknown sliders gracefully', () => {
    const v = renderVoice('coach', { unknown: 'value' } as unknown as SliderState)
    expect(v).toContain('Coach')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd plugin && bun test test/personality-presets.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the module**

Create `plugin/personality-presets.ts`:

```typescript
export type PresetId = 'coach' | 'drill-sergeant' | 'mentor' | 'pal' | 'professor'

export const PRESETS: Record<PresetId, { name: string; snippet: string }> = {
  'coach': {
    name: 'Coach',
    snippet:
      'Coach — warm, patient, asks before answering. Reflect what you ' +
      'hear before responding. Hold space for the user to think.',
  },
  'drill-sergeant': {
    name: 'Drill Sergeant',
    snippet:
      'Drill Sergeant — terse, direct, demanding follow-through. Don\'t ' +
      'soften hard truths. Hold the bar. Reward effort, not output.',
  },
  'mentor': {
    name: 'Mentor',
    snippet:
      'Mentor — balanced, advice-on-request, holds space. Bring ' +
      'experience but don\'t lecture. Ask first; advise second.',
  },
  'pal': {
    name: 'Pal',
    snippet:
      'Pal — casual, playful, encouraging. Light humor where it fits. ' +
      'Keep it real — not performative cheerleading.',
  },
  'professor': {
    name: 'Professor',
    snippet:
      'Professor — formal, thorough, comprehensive. Cite sources when ' +
      'relevant. Distinguish established knowledge from your own opinion.',
  },
}

export interface SliderState {
  // Educator: Socratic (push to discover) ↔ Direct (give the answer)
  socratic?: 'socratic' | 'direct'
  // Coach/Mentor: Patient (gentle nudge) ↔ Demanding (pull no punches)
  patience?: 'patient' | 'demanding'
  // Coach/Mentor: Earnest (no winks) ↔ Playful (banter encouraged)
  earnestness?: 'earnest' | 'playful'
  // Service: Quiet (notify only when needed) ↔ Verbose (chatty)
  verbosity?: 'quiet' | 'verbose'
  // Creative: Conventional ↔ Avant-garde
  taste?: 'conventional' | 'avant-garde'
}

const SLIDER_TEXT: Record<keyof SliderState, Record<string, string>> = {
  socratic: {
    socratic: 'Socratic — answer questions with questions when the user can find the answer themselves. Push them to discover.',
    direct:   'Direct — answer plainly when asked. Don\'t play teacher.',
  },
  patience: {
    patient:   'Patient — gentle nudges, not pull-no-punches.',
    demanding: 'Demanding — pull no punches when the user is dodging.',
  },
  earnestness: {
    earnest: 'Earnest — no winks or jokes about hard things.',
    playful: 'Playful — banter is welcome; lighten the load when it helps.',
  },
  verbosity: {
    quiet:   'Quiet — notify only when something genuinely needs the user.',
    verbose: 'Verbose — keep the user in the loop with regular updates.',
  },
  taste: {
    conventional: 'Conventional — favor proven approaches and canonical references.',
    'avant-garde': 'Avant-garde — favor unexpected combinations and unconventional references.',
  },
}

export function renderVoice(preset: PresetId, sliders: SliderState): string {
  const lines = [PRESETS[preset].snippet]
  for (const [key, value] of Object.entries(sliders) as [keyof SliderState, string][]) {
    const text = SLIDER_TEXT[key]?.[value]
    if (text) lines.push(text)
  }
  return lines.join(' ')
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/personality-presets.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/personality-presets.ts plugin/test/personality-presets.test.ts
git commit -m "feat(personality): five preset snippets + slider rendering"
```

### Task 3.2: Liability frames module

**Files:**
- Create: `plugin/liability-frames.ts`
- Create: `plugin/test/liability-frames.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugin/test/liability-frames.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { renderLiability, LIABILITY_FRAMES } from '../liability-frames.js'

describe('Liability frames', () => {
  test('renders a frame for each known flag', () => {
    for (const flag of Object.keys(LIABILITY_FRAMES)) {
      const frame = renderLiability(flag as any)
      expect(frame.length).toBeGreaterThan(50)
      expect(frame.toLowerCase()).toContain('not')  // some form of "you are not a..."
    }
  })

  test('returns empty string for null', () => {
    expect(renderLiability(null)).toBe('')
  })

  test('medical frame mentions clinician language', () => {
    const f = renderLiability('medical')
    expect(f.toLowerCase()).toMatch(/clinician|provider|doctor|medical/)
  })

  test('legal frame mentions attorney language', () => {
    const f = renderLiability('legal')
    expect(f.toLowerCase()).toMatch(/attorney|lawyer|counsel|legal advice/)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd plugin && bun test test/liability-frames.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the module**

Create `plugin/liability-frames.ts`:

```typescript
import type { LiabilityFlag } from './leaves.js'

export const LIABILITY_FRAMES: Record<LiabilityFlag, string> = {
  'medical':
    'You are not a licensed clinician. You don\'t diagnose, prescribe, ' +
    'or render binding medical advice. If the user describes symptoms ' +
    'or a situation that warrants seeing a provider, recommend they do — ' +
    'without overstating urgency or being alarmist.',
  'legal':
    'You are not a licensed attorney. You don\'t render binding legal ' +
    'advice. Help the user understand options and prepare to talk to ' +
    'counsel; do not draft binding language without explicit caveats.',
  'financial-investment':
    'You are not a licensed financial advisor. You don\'t recommend ' +
    'specific investments, predict returns, or advise on tax-advantaged ' +
    'accounts as if you held a fiduciary role. Focus on principles, ' +
    'tradeoffs, and questions the user should bring to a real advisor.',
  'tax':
    'You are not a CPA or licensed tax preparer. Help the user organize ' +
    'documents, understand forms, and identify questions for a real ' +
    'preparer. Do not file or sign anything on their behalf.',
  'immigration':
    'You are not an immigration attorney. Help the user track paperwork, ' +
    'understand processes, and prepare for interactions with USCIS or ' +
    'consular services. Do not advise on case strategy without ' +
    'explicit caveats; recommend competent counsel for non-routine cases.',
  'veterinary':
    'You are not a veterinarian. Help the user triage and prepare for ' +
    'a vet visit. Do not diagnose or recommend treatment. For ingestion, ' +
    'major trauma, or anything time-sensitive, send them to an emergency vet.',
  'religious-authority':
    'You are not clergy or a tradition\'s authority. Engage with texts, ' +
    'practices, and questions on the user\'s terms; do not arbitrate ' +
    'interpretation or speak for any institution.',
  'eldercare':
    'You are not a geriatric clinician or licensed care planner. Help ' +
    'the user organize decisions and prepare for conversations with ' +
    'providers. For acute concerns or capacity questions, recommend a ' +
    'professional assessment.',
  'mental-health':
    'You are not a licensed mental-health clinician. You don\'t diagnose ' +
    'or treat conditions. Listen, reflect, and — when the situation calls ' +
    'for it — encourage the user to seek a real provider. If the user ' +
    'expresses intent to harm themselves or others, prioritize 988 ' +
    '(US) / local crisis lines and stay with them through the next step.',
}

export function renderLiability(flag: LiabilityFlag | null): string {
  if (!flag) return ''
  return LIABILITY_FRAMES[flag]
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/liability-frames.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/liability-frames.ts plugin/test/liability-frames.test.ts
git commit -m "feat(liability): nine non-advisory frames + render helper"
```

---

## Phase 4: System-prompt assembler

### Task 4.1: Composition pure function

**Files:**
- Create: `plugin/prompt-assembler.ts`
- Create: `plugin/test/prompt-assembler.test.ts`

- [ ] **Step 1: Write the failing test for single-leaf assembly**

Create `plugin/test/prompt-assembler.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { setLeavesDir, type Leaf } from '../leaves.js'
import { assembleSystemPrompt, type AssembleInputs } from '../prompt-assembler.js'

beforeEach(() => {
  setLeavesDir(join(import.meta.dir, '..', 'leaves'))
})

describe('System-prompt assembler', () => {
  test('assembles a single-leaf Tutor prompt', () => {
    const input: AssembleInputs = {
      leafIds: ['tutor'],
      preset: 'drill-sergeant',
      sliders: { socratic: 'direct' },
      preferences: [
        'When Sam is stuck, push them to discover the answer.',
        'Always require Sam to show their work.',
      ],
      tools: ['gmail'],
      parameters: { tutor: 'Algebra II' },
      identityPreamble: 'You are an Algebra II tutor for Sam, an 8th grader.',
    }
    const prompt = assembleSystemPrompt(input)
    expect(prompt).toContain('Algebra II tutor for Sam')
    expect(prompt).toContain('Drill Sergeant')
    expect(prompt).toContain('Direct')
    expect(prompt).toContain('push them to discover')
    expect(prompt).toContain('always require')
    expect(prompt.toLowerCase()).toContain('gmail')
  })

  test('assembles a mash-up prompt with lead annotation', () => {
    const input: AssembleInputs = {
      leafIds: ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      leadLeafId: 'sleep-coach',
      preset: 'mentor',
      sliders: { patience: 'patient', earnestness: 'earnest' },
      preferences: [
        'Sleep is the bigger pain right now, but stress is what is driving it.',
        'Be honest, but precede hard observations with reflection of what the user shared.',
      ],
      tools: ['oura'],
      parameters: {},
      identityPreamble:
        'You are a wellness partner who unifies sleep, stress, and mindfulness ' +
        'into one coherent practice. Sleep is the lead lens.',
    }
    const prompt = assembleSystemPrompt(input)
    expect(prompt).toContain('Sleep is the lead lens')
    expect(prompt).toContain('Sleep coach')
    expect(prompt).toContain('Stress-management coach')
    expect(prompt).toContain('Mentor')
    expect(prompt).toContain('Patient')
    expect(prompt).toContain('Earnest')
    expect(prompt).toContain('Sleep is the bigger pain')
  })

  test('appends the medical liability frame for medical-flagged leaves', () => {
    const prompt = assembleSystemPrompt({
      leafIds: ['sleep-coach'],
      preset: 'coach',
      sliders: {},
      preferences: [],
      tools: [],
      parameters: {},
      identityPreamble: 'You are a sleep coach.',
    })
    expect(prompt).toContain('not a licensed clinician')
  })

  test('produces five paragraph breaks (six paragraphs counting blank-tail)', () => {
    const prompt = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: ['Be patient with Sam.'],
      tools: [],
      parameters: { tutor: 'Algebra II' },
      identityPreamble: 'You are a tutor.',
    })
    const paragraphs = prompt.split(/\n\s*\n/).filter(p => p.trim())
    expect(paragraphs.length).toBe(5)
  })

  test('omits Specific preferences paragraph when none', () => {
    const prompt = assembleSystemPrompt({
      leafIds: ['tutor'],
      preset: 'mentor',
      sliders: {},
      preferences: [],
      tools: [],
      parameters: { tutor: 'Algebra II' },
      identityPreamble: 'You are a tutor.',
    })
    expect(prompt).not.toContain('Specific preferences')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd plugin && bun test test/prompt-assembler.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the assembler**

Create `plugin/prompt-assembler.ts`:

```typescript
import { findLeaf } from './leaves.js'
import {
  PRESETS,
  renderVoice,
  type PresetId,
  type SliderState,
} from './personality-presets.js'
import { renderLiability } from './liability-frames.js'

export interface AssembleInputs {
  leafIds: string[]
  leadLeafId?: string
  preset: PresetId
  sliders: SliderState
  preferences: string[]
  tools: string[]
  parameters: Record<string, string>
  identityPreamble: string
}

export function assembleSystemPrompt(input: AssembleInputs): string {
  const leaves = input.leafIds
    .map(id => findLeaf(id))
    .filter((l): l is NonNullable<ReturnType<typeof findLeaf>> => l !== null)
  if (leaves.length === 0) {
    throw new Error('assembleSystemPrompt: no valid leaves')
  }

  // Paragraph 1 — Identity
  const identity = input.identityPreamble.trim()

  // Paragraph 2 — Expertise
  let expertise: string
  if (leaves.length === 1) {
    expertise = `Your expertise. ${leaves[0].expertise.trim()}`
  } else {
    const blocks = leaves.map(l => {
      const isLead = l.id === input.leadLeafId
      const tag = isLead ? `${l.name} (lead)` : l.name
      return `${tag}: ${l.expertise.trim()}`
    })
    expertise = `Your expertise. ${blocks.join(' ')}`
  }

  // Paragraph 3 — Voice
  const voice = `How you sound. ${renderVoice(input.preset, input.sliders)}`

  // Paragraph 4 — Specific preferences (omitted if empty)
  const preferencesText = input.preferences.length
    ? `Specific preferences from this user. ${input.preferences.join(' ')}`
    : null

  // Paragraph 5 — Scope (always present; tools + liability)
  const scopeParts: string[] = ['What is in and out of scope.']
  if (input.tools.length) {
    scopeParts.push(`Tools available: ${input.tools.join(', ')}.`)
  }
  for (const l of leaves) {
    const lf = renderLiability(l.liability)
    if (lf) scopeParts.push(lf)
  }
  const scope = scopeParts.join(' ')

  const paragraphs = [identity, expertise, voice]
  if (preferencesText) paragraphs.push(preferencesText)
  paragraphs.push(scope)

  return paragraphs.join('\n\n')
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/prompt-assembler.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/prompt-assembler.ts plugin/test/prompt-assembler.test.ts
git commit -m "feat(prompt): five-paragraph system-prompt assembler"
```

---

## Phase 5: Coach state machine

### Task 5.1: State machine + per-leaf-shape script

**Files:**
- Create: `plugin/coach.ts`
- Create: `plugin/test/coach.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugin/test/coach.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from 'bun:test'
import { join } from 'node:path'
import { setLeavesDir } from '../leaves.js'
import {
  startCoach,
  advanceCoach,
  isCoachDone,
  collectAnswers,
  type CoachState,
} from '../coach.js'

beforeEach(() => {
  setLeavesDir(join(import.meta.dir, '..', 'leaves'))
})

describe('Coach state machine', () => {
  test('Tutor coach asks for parameter first', () => {
    const s = startCoach({ leafIds: ['tutor'], preset: 'drill-sergeant', sliders: {} })
    expect(s.nextQuestion).toBeTruthy()
    expect(s.nextQuestion!.toLowerCase()).toContain('subject')
    expect(isCoachDone(s)).toBe(false)
  })

  test('skip-the-interview escape works on first user message', () => {
    let s: CoachState = startCoach({ leafIds: ['tutor'], preset: 'mentor', sliders: {} })
    s = advanceCoach(s, "let's go")
    expect(isCoachDone(s)).toBe(true)
    const answers = collectAnswers(s)
    expect(answers.preferences).toEqual([])
  })

  test('Tutor flow captures subject + style + tools', () => {
    let s: CoachState = startCoach({ leafIds: ['tutor'], preset: 'drill-sergeant', sliders: {} })
    s = advanceCoach(s, 'Algebra II, my 8th grader Sam')
    s = advanceCoach(s, 'Push them. Always show work.')
    s = advanceCoach(s, 'Yes, watch my Gmail')
    expect(isCoachDone(s)).toBe(true)

    const answers = collectAnswers(s)
    expect(answers.parameters.tutor).toMatch(/algebra/i)
    expect(answers.preferences.join(' ').toLowerCase()).toContain('push')
    expect(answers.preferences.join(' ').toLowerCase()).toContain('show work')
    expect(answers.tools).toContain('gmail')
  })

  test('Mash-up coach asks lead question', () => {
    const s = startCoach({
      leafIds: ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide'],
      preset: 'mentor', sliders: {},
    })
    expect(s.nextQuestion?.toLowerCase()).toMatch(/which|lead|bigger pain/)
  })

  test('Service coach asks schedule + sources', () => {
    const s = startCoach({ leafIds: ['daily-news-feed-briefing'], preset: 'mentor', sliders: {} })
    expect(s.nextQuestion?.toLowerCase()).toMatch(/topic|time|schedule/)
  })

  test('reflectiveAck wraps user input before the next question', () => {
    let s: CoachState = startCoach({ leafIds: ['tutor'], preset: 'mentor', sliders: {} })
    s = advanceCoach(s, 'Algebra II for my 8th grader')
    expect(s.lastReflection?.toLowerCase()).toContain('algebra')
  })

  test('cap warning surfaces when 4+ leaves', () => {
    const s = startCoach({
      leafIds: ['sleep-coach', 'stress-management-coach', 'mindfulness-meditation-guide', 'nutrition-partner'],
      preset: 'mentor', sliders: {},
    })
    expect(s.warnings.some(w => w.toLowerCase().includes('dilute'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd plugin && bun test test/coach.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement the coach state machine**

Create `plugin/coach.ts`:

```typescript
import { findLeaf } from './leaves.js'
import type { PresetId, SliderState } from './personality-presets.js'

interface QuestionStep {
  id: string
  question: (ctx: CoachInputs) => string
  capture: (s: CoachState, answer: string) => void
}

export interface CoachInputs {
  leafIds: string[]
  preset: PresetId
  sliders: SliderState
}

export interface CoachAnswers {
  parameters: Record<string, string>
  preferences: string[]
  tools: string[]
  leadLeafId?: string
}

export interface RefineInputs {
  agentId: string
  existingPrompt: string
}

export interface CoachState {
  inputs: CoachInputs
  remaining: QuestionStep[]
  answers: CoachAnswers
  nextQuestion: string | null
  lastReflection: string | null
  warnings: string[]
  /** Set when the state was created via startRefineCoach (Phase 11). */
  refineContext?: RefineInputs
}

const SKIP_PATTERN = /^(let'?s go|just go|skip|use defaults)\b/i

const TOOL_HINTS: Array<[RegExp, string]> = [
  [/\bgmail\b/i, 'gmail'],
  [/\bcalendar\b/i, 'calendar'],
  [/\boura\b/i, 'oura'],
  [/\bapple\s*health\b/i, 'apple-health'],
  [/\bgithub\b/i, 'github'],
  [/\bslack\b/i, 'slack'],
]

function detectTools(text: string): string[] {
  return TOOL_HINTS.filter(([re]) => re.test(text)).map(([, tool]) => tool)
}

function reflect(text: string): string {
  // Compact echo of the user's answer for the reflect-always pattern.
  // Trim long answers; strip filler.
  const clean = text.trim().replace(/^(yes,?\s*|sure,?\s*|ok,?\s*)/i, '')
  if (clean.length <= 60) return `Got it: ${clean}.`
  return `Got it.`
}

function buildSteps(inputs: CoachInputs): QuestionStep[] {
  const leaves = inputs.leafIds.map(findLeaf).filter((l): l is NonNullable<ReturnType<typeof findLeaf>> => l !== null)
  const steps: QuestionStep[] = []

  // Q1 — parameter (single leaf with parameter) OR lead pick (mash-up) OR schedule (service)
  if (leaves.length === 1) {
    const l = leaves[0]
    if (l.parameter) {
      steps.push({
        id: 'parameter',
        question: () => `Got it — a ${l.name.toLowerCase()}. ${parameterPrompt(l.parameter!, l.name)}`,
        capture: (s, a) => { s.answers.parameters[l.id] = a },
      })
    } else if (l.path === 'Service') {
      steps.push({
        id: 'service',
        question: () => `What topics, sources, or schedule do you want for the ${l.name.toLowerCase()}?`,
        capture: (s, a) => { s.answers.preferences.push(a) },
      })
    }
  } else {
    steps.push({
      id: 'lead',
      question: () => `Which of these specialties is the bigger pain right now: ${leaves.map(l => l.name).join(', ')}?`,
      capture: (s, a) => {
        const matched = leaves.find(l => a.toLowerCase().includes(l.name.split(/\s/)[0].toLowerCase()))
        if (matched) s.answers.leadLeafId = matched.id
        s.answers.preferences.push(`User said the lead concern is: ${a}`)
      },
    })
  }

  // Q2 — voice / style
  steps.push({
    id: 'voice',
    question: () => `How direct should I be — gentle nudge, or pull no punches?`,
    capture: (s, a) => { s.answers.preferences.push(`Tone preference: ${a}`) },
  })

  // Q3 — tools / monitoring
  steps.push({
    id: 'tools',
    question: () => `Are there services I should connect to (Gmail, calendar, Oura, etc.) or skip?`,
    capture: (s, a) => {
      s.answers.tools.push(...detectTools(a))
      s.answers.preferences.push(`Tools/monitoring: ${a}`)
    },
  })

  return steps
}

function parameterPrompt(parameter: string, leafName: string): string {
  const map: Record<string, string> = {
    'subject': 'What subject, and who is the learner?',
    'target language': 'What language, and where are you starting from?',
    'which test': 'Which test, and how long until it?',
    'writing type': 'What kind of writing, and what is the deadline?',
    'cuisine': 'Which cuisine?',
    'genre': 'What genre, and what is the project?',
    'species': 'What species, and what is the behavior issue?',
    'goal (weight loss, 5K, hypertrophy, mobility)': 'What is the specific goal?',
    'tradition': 'Which tradition?',
    'topic': 'What is the topic?',
  }
  return map[parameter] || `What ${parameter.replace(/[()]/g, '')}?`
}

export function startCoach(inputs: CoachInputs): CoachState {
  const remaining = buildSteps(inputs)
  const warnings: string[] = []
  if (inputs.leafIds.length >= 4) {
    warnings.push('Adding more may dilute the agent\'s focus. Three is usually the sweet spot.')
  }
  const state: CoachState = {
    inputs,
    remaining,
    answers: { parameters: {}, preferences: [], tools: [] },
    nextQuestion: null,
    lastReflection: null,
    warnings,
  }
  state.nextQuestion = remaining[0]?.question(inputs) ?? null
  return state
}

export function advanceCoach(s: CoachState, userMessage: string): CoachState {
  if (SKIP_PATTERN.test(userMessage.trim())) {
    return { ...s, remaining: [], nextQuestion: null, lastReflection: 'Got it — going with defaults.' }
  }
  const step = s.remaining[0]
  if (!step) return s
  step.capture(s, userMessage)
  const remaining = s.remaining.slice(1)
  const nextQuestion = remaining[0]?.question(s.inputs) ?? null
  return { ...s, remaining, nextQuestion, lastReflection: reflect(userMessage) }
}

export function isCoachDone(s: CoachState): boolean {
  return s.remaining.length === 0
}

export function collectAnswers(s: CoachState): CoachAnswers {
  return s.answers
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/coach.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugin/coach.ts plugin/test/coach.test.ts
git commit -m "feat(coach): per-leaf-shape interview state machine"
```

---

## Phase 6: Wall navigation CX

This phase replaces the template grid in `agent-setup.html` with the wall + drill-down + detail card. Single-leaf flow first; mash-up overlay comes in Phase 7. All work is gated behind a feature flag (`window.NEW_AGENT_FLOW`) until Phase 11.

### Task 6.1: Surface catalog data to the WebXDC card

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts`

The card receives leaf data through the existing `init` payload. Add a new field, populated server-side from the catalog loader.

- [ ] **Step 1: Locate the existing `init` payload assembly in `agent-setup-app.ts`**

```bash
cd plugin && grep -n "type: 'init'" apps/agent-setup-app.ts
```

- [ ] **Step 2: Add a `leaves` and `l2Summary` field to that payload**

In `apps/agent-setup-app.ts`, where the init payload is built, add:

```typescript
import { loadAllLeaves, leavesByPath } from '../leaves.js'

// Inside the init payload assembly:
const leaves = loadAllLeaves()
const byPath = leavesByPath()
const l2Summary = buildL2Summary(leaves)

const update = {
  type: 'init',
  // ...existing fields
  newAgentFlow: {
    enabled: process.env.DC_NEW_AGENT_FLOW === '1',
    leaves: leaves.map(l => ({
      id: l.id,
      path: l.path,
      l2: l.l2,
      name: l.name,
      parameter: l.parameter,
      liability: l.liability,
      pitch: l.pitch,
      combinesWith: l.combinesWith,
    })),
    l2Summary,
  },
}

function buildL2Summary(leaves: Leaf[]) {
  const map = new Map<string, { path: string; l2: string; count: number; sample: string[] }>()
  for (const l of leaves) {
    if (!map.has(l.l2)) {
      map.set(l.l2, { path: l.path, l2: l.l2, count: 0, sample: [] })
    }
    const e = map.get(l.l2)!
    e.count++
    if (e.sample.length < 3) e.sample.push(l.name)
  }
  return [...map.values()]
}
```

- [ ] **Step 3: Type-check and run existing tests**

```bash
cd plugin && bun test
```

Expected: existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/agent-setup-app.ts
git commit -m "feat(agent-setup): surface leaf catalog through init payload"
```

### Task 6.2: Bump APP_VERSION + add the wall HTML/CSS skeleton

**Files:**
- Modify: `plugin/webxdc/agent-setup.html`

- [ ] **Step 1: Bump the APP_VERSION**

Locate the version constant near the top of the script section:

```javascript
var APP_VERSION = 1.78  // change to 1.79
```

- [ ] **Step 2: Add the wall screen container next to `#new-chat`**

Inside the same scope as `#new-chat`, add:

```html
<div id="wall-screen" style="display:none">
  <div class="title-bar">
    <button class="crumb" type="button" onclick="show('step0')">Home</button>
    <div class="title">Build new agent</div>
  </div>
  <div class="body">
    <div class="search-wrap">
      <svg class="search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/></svg>
      <input id="wall-search" placeholder="Filter — e.g., 'sleep', 'tax', 'kid'…" oninput="onWallSearch()">
    </div>
    <div id="wall-helper" class="helper">155 agents grouped by 26 specialties. Tap a tile to see all of its agents, or filter.</div>
    <div id="wall-grid"></div>
    <div id="wall-results" style="display:none"></div>
    <div id="wall-l2"></div>
    <div id="wall-leaf-detail"></div>
  </div>
</div>
```

- [ ] **Step 3: Add the matching CSS**

In the `<style>` block, add the wall-specific tokens (the eight existing palettes already cover everything else):

```css
/* Wall navigation */
.wall-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.wall-tile { background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 10px; cursor: pointer; transition: border-color 0.12s; }
.wall-tile:hover { border-color: var(--orange); }
.wall-tile-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.wall-tile-name { font-weight: 600; font-size: 12.5px; line-height: 1.3; }
.wall-tile-count { margin-left: auto; font-size: 10px; color: var(--text-dim); font-family: ui-monospace, monospace; }
.wall-tile-samples { color: var(--text-mute); font-size: 10.5px; line-height: 1.5; }
.wall-tile-samples .dot { color: var(--text-dim); margin: 0 4px; }

.tag { display: inline-block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 7px; border-radius: 999px; line-height: 1.4; }
.tag.expert { color: var(--orange); background: rgba(217, 119, 87, 0.13); }
.tag.service { color: var(--green); background: rgba(109, 184, 109, 0.13); }
.tag.goal { color: var(--blue); background: rgba(109, 163, 217, 0.14); }

.search-wrap { position: relative; margin-bottom: 14px; }
.search-wrap input { width: 100%; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink); padding: 11px 14px 11px 38px; border-radius: 10px; font: inherit; outline: none; }
.search-wrap input:focus { border-color: var(--orange); }
.search-icon { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; stroke: var(--text-mute); fill: none; stroke-width: 2; }
```

- [ ] **Step 4: Add the home-screen entry point routing**

Modify `gotoNewChat()` (or replace it) so that when `newAgentFlow.enabled === true`, it shows `#wall-screen` instead of `#new-chat`:

```javascript
function gotoNewChat() {
  if (state.newAgentFlow?.enabled) {
    show('wall-screen')
    renderWall()
    return
  }
  // Existing v1.x path
  show('new-chat')
  renderTemplates()
  renderPickList()
}
```

- [ ] **Step 5: Implement `renderWall()` and `onWallSearch()`**

In the script section:

```javascript
function pathTag(p) {
  return '<span class="tag '+p.toLowerCase()+'">'+p+'</span>'
}

function renderWall() {
  hideAll(['wall-results', 'wall-l2', 'wall-leaf-detail'])
  document.getElementById('wall-helper').style.display = ''
  document.getElementById('wall-grid').style.display = ''

  var html = '<div class="wall-grid">'
  var sorted = (state.newAgentFlow.l2Summary || []).slice().sort(function(a, b) {
    var order = { Expert: 0, Service: 1, Goal: 2 }
    return order[a.path] - order[b.path]
  })
  for (var i = 0; i < sorted.length; i++) {
    var t = sorted[i]
    var samples = t.sample.slice(0, 3).map(escapeHtml).join('<span class="dot">·</span>')
    html += '<div class="wall-tile" onclick="enterL2(\'' + escapeJs(t.l2) + '\')">' +
              '<div class="wall-tile-head">' + pathTag(t.path) +
                '<span class="wall-tile-name">' + escapeHtml(t.l2) + '</span>' +
                '<span class="wall-tile-count">' + t.count + '</span></div>' +
              '<div class="wall-tile-samples">' + samples + '</div>' +
            '</div>'
  }
  html += '</div>'
  document.getElementById('wall-grid').innerHTML = html
}

function onWallSearch() {
  var q = (document.getElementById('wall-search').value || '').trim().toLowerCase()
  if (!q) { renderWall(); return }
  document.getElementById('wall-helper').style.display = 'none'
  document.getElementById('wall-grid').style.display = 'none'
  document.getElementById('wall-l2').innerHTML = ''
  document.getElementById('wall-leaf-detail').innerHTML = ''

  var matches = (state.newAgentFlow.leaves || []).filter(function(l) {
    return (l.name + ' ' + l.l2 + ' ' + (l.pitch || '') + ' ' + (l.parameter || '')).toLowerCase().indexOf(q) !== -1
  })
  var html = matches.length === 0
    ? '<div class="results-empty">No agents match "'+ escapeHtml(q) +'"</div>'
    : matches.slice(0, 25).map(function(l) {
        return '<div class="leaf-row" onclick="showLeafDetail(\''+ escapeJs(l.id) +'\')">'+
                  pathTag(l.path) +
                  '<span style="flex:1; min-width:0">' + escapeHtml(l.name) + '</span>' +
                  '<span style="color: var(--text-dim); font-size: 11px;">' + escapeHtml(l.l2) + '</span>' +
                '</div>'
      }).join('')
  document.getElementById('wall-results').style.display = ''
  document.getElementById('wall-results').innerHTML = html
}

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }
function escapeJs(s) { return String(s).replace(/\\/g,'\\\\').replace(/'/g,"\\'") }
function hideAll(ids) { for (var i = 0; i < ids.length; i++) document.getElementById(ids[i]).style.display = 'none' }
```

- [ ] **Step 6: Commit**

```bash
git add plugin/webxdc/agent-setup.html
git commit -m "feat(agent-setup): wall screen scaffold + tile rendering + search"
```

### Task 6.3: L2 drill-in + leaf detail card

- [ ] **Step 1: Implement `enterL2()`, `exitL2()`, `showLeafDetail()`, `hideLeafDetail()`**

```javascript
function enterL2(l2) {
  document.getElementById('wall-helper').style.display = 'none'
  document.getElementById('wall-grid').style.display = 'none'
  document.getElementById('wall-results').style.display = 'none'
  document.getElementById('wall-leaf-detail').innerHTML = ''

  var leaves = state.newAgentFlow.leaves.filter(function(l) { return l.l2 === l2 })
  var path = leaves[0] ? leaves[0].path : 'Expert'
  var html = '<div class="L2-list">' +
    '<div class="back-bar" onclick="renderWall()"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 6 9 12 15 18"/></svg> Back to specialties</div>' +
    '<div style="padding: 10px 14px; display: flex; align-items: center; gap: 8px;">' + pathTag(path) + '<strong style="font-size: 14px;">' + escapeHtml(l2) + '</strong></div>'
  for (var i = 0; i < leaves.length; i++) {
    var l = leaves[i]
    var paramStr = l.parameter ? ' <span class="param">— ' + escapeHtml(l.parameter) + '</span>' : ''
    html += '<div class="leaf-row" onclick="showLeafDetail(\'' + escapeJs(l.id) + '\')">' + escapeHtml(l.name) + paramStr + '</div>'
  }
  html += '</div>'
  document.getElementById('wall-l2').innerHTML = html
}

function showLeafDetail(leafId) {
  var l = state.newAgentFlow.leaves.find(function(x) { return x.id === leafId })
  if (!l) return
  var html = '<div class="leaf-detail">' +
    '<div class="leaf-detail-head">' + pathTag(l.path) + '<h3>' + escapeHtml(l.name) + '</h3></div>' +
    (l.parameter ? '<div class="meta"><strong>Asks you about:</strong> ' + escapeHtml(l.parameter) + '</div>' : '') +
    '<div class="pitch">' + escapeHtml(l.pitch) + '</div>' +
    // Pairs-with chips will be added in Phase 7
    '<div class="cta-row">' +
      '<button class="btn-primary" onclick="buildSingleLeaf(\'' + escapeJs(l.id) + '\')">Build now</button>' +
    '</div>' +
    '<div style="text-align: center; margin-top: 10px;"><a href="#" onclick="hideLeafDetail(); return false;" style="font-size: 12px; color: var(--text-dim);">cancel</a></div>' +
  '</div>'
  document.getElementById('wall-leaf-detail').innerHTML = html
  document.getElementById('wall-leaf-detail').scrollIntoView({behavior: 'smooth', block: 'start'})
}

function hideLeafDetail() {
  document.getElementById('wall-leaf-detail').innerHTML = ''
}

function buildSingleLeaf(leafId) {
  // Phase 7 wires this to the coach handoff. For now, emit a placeholder.
  webxdc.sendUpdate({ payload: { type: 'build-agent', leafIds: [leafId], senderAddr: webxdc.selfAddr } }, '')
}
```

- [ ] **Step 2: Add the matching CSS for the leaf detail card and L2 list**

```css
.L2-list { background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 6px 0; margin-bottom: 14px; }
.back-bar { padding: 8px 14px; border-bottom: 1px solid var(--line); color: var(--text-mute); font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.back-bar:hover { color: var(--orange); }
.leaf-row { padding: 9px 14px; cursor: pointer; font-size: 13px; color: var(--ink); line-height: 1.45; display: flex; align-items: center; gap: 6px; }
.leaf-row:hover { background: rgba(217, 119, 87, 0.08); color: var(--orange); }
.leaf-row .param { color: var(--text-dim); font-size: 11px; }
.leaf-detail { margin-top: 14px; padding: 14px; background: var(--surface-2); border: 1px solid var(--orange); border-radius: 10px; }
.leaf-detail-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.leaf-detail h3 { font-size: 16px; flex: 1; }
.leaf-detail .pitch { color: var(--text-mute); font-size: 13px; line-height: 1.55; margin: 8px 0 12px; }
.leaf-detail .meta { font-size: 11px; color: var(--text-dim); margin-bottom: 10px; }
.leaf-detail .meta strong { color: var(--text-mute); font-weight: 600; }
.cta-row { display: flex; gap: 8px; margin-top: 8px; }
.btn-primary { flex: 1; padding: 11px 14px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; border: none; background: var(--orange); color: #fff; }
.btn-secondary { flex: 1; padding: 11px 14px; border-radius: 8px; font: inherit; font-weight: 600; cursor: pointer; background: transparent; border: 1px solid var(--orange); color: var(--orange); }
```

- [ ] **Step 3: Test manually**

Set `DC_NEW_AGENT_FLOW=1`, restart the dispatcher, send the agent-setup card to a paired chat, tap "Start a new chat" → wall appears → tap a tile → leaf list → tap a leaf → detail card.

- [ ] **Step 4: Commit**

```bash
git add plugin/webxdc/agent-setup.html
git commit -m "feat(agent-setup): wall L2 drill-in + leaf detail card"
```

### Task 6.4: Wall UI Playwright test

**Files:**
- Create: `plugin/test/webxdc/agent-setup-wall.test.ts`

- [ ] **Step 1: Write a Playwright test that asserts wall renders 26 tiles**

Mirror the pattern in existing `plugin/test/webxdc/` tests. The test loads the WebXDC HTML in headless Chromium with a stubbed `webxdc` global, sends an `init` update with the leaf catalog, and asserts:
- 26 wall tiles render
- Searching for "sleep" surfaces Sleep coach
- Tapping a tile shows the L2 leaf list
- Tapping a leaf shows the detail card

(Full test code: ~100 lines following the pattern in `plugin/test/webxdc/permission-prompt.test.ts`. The tests use `@playwright/test` already in the dev deps.)

- [ ] **Step 2: Run**

```bash
cd plugin/test/webxdc && bun run test
```

- [ ] **Step 3: Commit**

```bash
git add plugin/test/webxdc/agent-setup-wall.test.ts
git commit -m "test(agent-setup): Playwright tests for wall navigation"
```

---

## Phase 7: Mash-up CX

Adds the persistent build pill, pairs-with chips, review screen, and cap warning to the wall + leaf detail. Builds on Phase 6.

### Task 7.1: Build state on the client side

**Files:**
- Modify: `plugin/webxdc/agent-setup.html`

- [ ] **Step 1: Add a build state object**

```javascript
state.build = []  // array of leaf ids in the in-progress mash-up
```

- [ ] **Step 2: Render the build pill**

Add a `<div id="build-pill" style="display:none"></div>` at the top of `#wall-screen .body`. Implement:

```javascript
function renderBuildPill() {
  var pill = document.getElementById('build-pill')
  if (state.build.length === 0) { pill.style.display = 'none'; return }
  var leaves = state.build.map(function(id) {
    return state.newAgentFlow.leaves.find(function(l) { return l.id === id })
  }).filter(Boolean)
  var n = leaves.length
  var label = n === 1 ? 'Building 1 specialist' : 'Mashing up ' + n + ' specialists'
  var sub = leaves.slice(0, 3).map(function(l) { return l.name }).join(' + ') + (n > 3 ? ' + ' + (n - 3) + ' more' : '')
  pill.innerHTML =
    '<div class="glyph">' + n + '</div>' +
    '<div style="flex:1; min-width:0">' +
      '<div class="build-pill-title">' + escapeHtml(label) + '</div>' +
      '<div class="build-pill-sub">' + escapeHtml(sub) + '</div>' +
    '</div>' +
    '<div class="build-pill-cta">Review →</div>'
  pill.onclick = function() { showReviewScreen() }
  pill.style.display = 'flex'
}
```

CSS:

```css
.build-pill { background: linear-gradient(135deg, var(--orange) 0%, #c46a4d 100%); color: #fff; border-radius: 12px; padding: 12px 14px; margin-bottom: 14px; cursor: pointer; box-shadow: 0 0 0 1px rgba(217,119,87,0.25); display: flex; align-items: center; gap: 10px; }
.build-pill .glyph { width: 24px; height: 24px; border-radius: 50%; background: rgba(255,255,255,0.2); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; }
.build-pill-title { font-weight: 700; font-size: 13.5px; line-height: 1.3; }
.build-pill-sub { font-size: 11px; opacity: 0.85; margin-top: 2px; }
.build-pill-cta { margin-left: auto; font-size: 12px; font-weight: 600; background: rgba(255,255,255,0.2); padding: 6px 12px; border-radius: 999px; }
.cap-warn { background: rgba(201, 140, 64, 0.12); border: 1px solid #c98c40; color: #c98c40; border-radius: 8px; padding: 8px 12px; font-size: 12px; line-height: 1.4; margin-bottom: 14px; }
```

Render the cap-warn after the pill when `state.build.length >= 4`.

- [ ] **Step 3: Update leaf detail to show pairs-with chips and dual CTAs**

Replace the leaf detail HTML in `showLeafDetail`:

```javascript
function showLeafDetail(leafId) {
  var l = state.newAgentFlow.leaves.find(function(x) { return x.id === leafId })
  if (!l) return
  var inBuild = state.build.indexOf(l.id) !== -1

  var pairs = (l.combinesWith || []).map(function(pid) {
    return state.newAgentFlow.leaves.find(function(x) { return x.id === pid })
  }).filter(Boolean)

  var pairsHtml = pairs.length === 0 ? '' :
    '<div class="pairs-with-label">Pairs well with — tap to add to your mash-up</div>' +
    '<div class="pairs-chips">' +
      pairs.map(function(p) {
        var added = state.build.indexOf(p.id) !== -1
        return '<span class="pair-chip ' + (added ? 'added' : '') + '" onclick="toggleBuild(\'' + escapeJs(p.id) + '\')">' +
                 '<span class="plus">' + (added ? '✓' : '+') + '</span>' + escapeHtml(p.name) +
               '</span>'
      }).join('') +
    '</div>'

  var ctaHtml
  if (inBuild) {
    ctaHtml = '<button class="btn-secondary" onclick="toggleBuild(\'' + escapeJs(l.id) + '\')">✓ In your mash-up</button>' +
              '<button class="btn-primary" onclick="showReviewScreen()">Review →</button>'
  } else if (state.build.length === 0) {
    ctaHtml = '<button class="btn-secondary" onclick="toggleBuild(\'' + escapeJs(l.id) + '\')">+ Add to mash-up</button>' +
              '<button class="btn-primary" onclick="buildSingleLeaf(\'' + escapeJs(l.id) + '\')">Build now</button>'
  } else {
    ctaHtml = '<button class="btn-secondary" onclick="toggleBuild(\'' + escapeJs(l.id) + '\')">+ Add to mash-up</button>' +
              '<button class="btn-primary" onclick="toggleBuild(\'' + escapeJs(l.id) + '\'); showReviewScreen()">Add &amp; review</button>'
  }

  document.getElementById('wall-leaf-detail').innerHTML =
    '<div class="leaf-detail">' +
      '<div class="leaf-detail-head">' + pathTag(l.path) + '<h3>' + escapeHtml(l.name) + '</h3></div>' +
      (l.parameter ? '<div class="meta"><strong>Asks you about:</strong> ' + escapeHtml(l.parameter) + '</div>' : '') +
      '<div class="pitch">' + escapeHtml(l.pitch) + '</div>' +
      pairsHtml +
      '<div class="cta-row">' + ctaHtml + '</div>' +
      '<div style="text-align: center; margin-top: 10px;"><a href="#" onclick="hideLeafDetail(); return false;" style="font-size: 12px; color: var(--text-dim);">cancel</a></div>' +
    '</div>'
}

function toggleBuild(leafId) {
  var idx = state.build.indexOf(leafId)
  if (idx === -1) state.build.push(leafId)
  else state.build.splice(idx, 1)
  renderBuildPill()
  // Re-render the open leaf detail to update CTA states + chip checkmarks
  var openDetail = document.getElementById('wall-leaf-detail')
  if (openDetail.innerHTML.length) {
    var match = openDetail.innerHTML.match(/showLeafDetail\('([a-z0-9-]+)'\)/)
    // Or just re-show from current state — track openLeafId in state.
  }
}
```

CSS for the chips:

```css
.pairs-with-label { font-size: 11px; color: var(--text-mute); margin: 12px 0 6px; font-weight: 600; }
.pairs-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
.pair-chip { background: var(--surface-1); border: 1px solid var(--line); color: var(--ink); border-radius: 999px; padding: 5px 11px 5px 9px; font-size: 11.5px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
.pair-chip:hover { border-color: var(--orange); color: var(--orange); }
.pair-chip .plus { font-weight: 700; color: var(--orange); font-size: 13px; }
.pair-chip.added { background: rgba(217, 119, 87, 0.12); border-color: var(--orange); color: var(--orange); }
```

- [ ] **Step 4: Implement the review screen**

```javascript
function showReviewScreen() {
  if (state.build.length === 0) return
  hideAll(['wall-grid', 'wall-helper', 'wall-results', 'wall-l2', 'wall-leaf-detail'])
  var leaves = state.build.map(function(id) {
    return state.newAgentFlow.leaves.find(function(l) { return l.id === id })
  }).filter(Boolean)
  var n = leaves.length
  var h2 = n === 1 ? 'Your new agent' : 'Your mash-up agent'
  var sub = n === 1
    ? 'A single specialist. The coach will help you tune its voice and tools next.'
    : 'These ' + n + ' specialties combine into <strong>one</strong> agent with a unified system prompt. The coach helps you weight them and tune voice next.'

  var html = '<div class="review-screen">' +
    '<h2>' + escapeHtml(h2) + '</h2><div class="sub">' + sub + '</div>' +
    '<div class="review-list">' + leaves.map(function(l) {
      return '<div class="review-item">' + pathTag(l.path) +
              '<div class="name">' + escapeHtml(l.name) + '</div>' +
              '<div class="where">' + escapeHtml(l.l2) + '</div>' +
              '<div class="x" onclick="toggleBuild(\'' + escapeJs(l.id) + '\')">×</div>' +
            '</div>'
    }).join('') + '</div>' +
    '<div class="merged-pitch"><strong>How it will introduce itself</strong>' +
      escapeHtml(composeMergedPitch(leaves)) + '</div>' +
    '<div class="review-cta-row">' +
      '<button class="btn-back-to-wall" onclick="renderWall()">+ Add another</button>' +
      '<button class="btn-build-final" onclick="buildMashup()">Build &amp; start chatting →</button>' +
    '</div></div>'
  document.getElementById('wall-l2').innerHTML = html
}

function composeMergedPitch(leaves) {
  if (leaves.length === 1) return leaves[0].pitch
  var firstSentences = leaves.map(function(l) {
    var s = l.pitch.split('. ')[0]
    return s.charAt(0).toLowerCase() + s.slice(1)
  })
  return '"I am a single agent who ' + firstSentences.join('; also ') + '. Tell me which side of me you need today."'
}

function buildSingleLeaf(leafId) {
  webxdc.sendUpdate({ payload: { type: 'build-agent', leafIds: [leafId], senderAddr: webxdc.selfAddr } }, '')
}

function buildMashup() {
  webxdc.sendUpdate({ payload: { type: 'build-agent', leafIds: state.build.slice(), senderAddr: webxdc.selfAddr } }, '')
}
```

- [ ] **Step 5: Commit**

```bash
git add plugin/webxdc/agent-setup.html
git commit -m "feat(agent-setup): mash-up build pill + pairs-with chips + review screen"
```

---

## Phase 8: Coach interview integration (server-side)

### Task 8.1: Handle `build-agent` payload by creating chat + spawning coach

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts`

- [ ] **Step 1: Add the `onWebXDCUpdate` branch for `build-agent`**

In `apps/agent-setup-app.ts`, locate the existing `onWebXDCUpdate` handler. Add a case:

```typescript
case 'build-agent': {
  const leafIds = (u.payload as { leafIds: string[] }).leafIds
  if (!Array.isArray(leafIds) || leafIds.length === 0) return
  await handleBuildAgent(ctx, msgId, leafIds)
  return
}
```

Then implement:

```typescript
import { startCoach, advanceCoach, isCoachDone, collectAnswers } from '../coach.js'
import { assembleSystemPrompt } from '../prompt-assembler.js'
import { findLeaf } from '../leaves.js'
import { writeAgent, putBinding } from '../agents.js'
import { v4 as uuidv4 } from 'uuid'  // or existing uuid import

async function handleBuildAgent(ctx: AppContext, originMsgId: number, leafIds: string[]) {
  // 1. Create a new DC chat (existing helper) and bind a placeholder agent ('coach' persona)
  const chatId = await createNewAgentChat(ctx, leafIds)
  const sessionId = uuidv4()

  // 2. Persist a coach-state record keyed by chatId in app session map
  const coachState = startCoach({
    leafIds,
    preset: 'mentor',  // default; user can change later via Refine
    sliders: {},
  })
  appSessions.set(chatId, { coachState, leafIds, sessionId })

  // 3. Post the first coach message into the new chat
  if (coachState.nextQuestion) {
    await ctx.client.send(chatId, coachState.nextQuestion + '\n\n(Or just say *let\'s go* and I\'ll use defaults.)')
  } else {
    // No questions for this leaf — graduate immediately
    await graduateAgent(ctx, chatId)
  }
}
```

(`createNewAgentChat` is a helper to be added; it creates a DC chat with an initial title and binds a placeholder coach AgentDef.)

- [ ] **Step 2: Add per-turn handler that advances the coach**

The dispatcher's existing per-turn pipeline calls `subagentCache.dispatch(chatId, message)` for ordinary turns. For chats currently in coach-mode, pre-empt that and route to the coach state machine instead. In the dispatcher `message-router.ts`:

```typescript
import { advanceCoach, isCoachDone, collectAnswers } from '../coach.js'
import { appSessions } from '../apps/agent-setup-app.js'

// In the dispatch function, before subagentCache.dispatch:
const session = appSessions.get(chatId)
if (session?.coachState) {
  session.coachState = advanceCoach(session.coachState, message.text || '')
  if (session.coachState.lastReflection) {
    await client.send(chatId, session.coachState.lastReflection)
  }
  if (isCoachDone(session.coachState)) {
    await graduateAgent(ctx, chatId)
  } else if (session.coachState.nextQuestion) {
    await client.send(chatId, session.coachState.nextQuestion)
  }
  return  // skip normal dispatch
}
```

- [ ] **Step 3: Implement `graduateAgent` — assemble prompt, swap binding, post first agent turn**

```typescript
async function graduateAgent(ctx: AppContext, chatId: number) {
  const session = appSessions.get(chatId)
  if (!session) return
  const answers = collectAnswers(session.coachState)

  const systemPrompt = assembleSystemPrompt({
    leafIds: session.leafIds,
    leadLeafId: answers.leadLeafId,
    preset: 'mentor',
    sliders: {},
    preferences: answers.preferences,
    tools: answers.tools,
    parameters: answers.parameters,
    identityPreamble: composeIdentityPreamble(session.leafIds, answers),
  })

  // Persist a real AgentDef
  const agentId = `agent-${chatId}-${Date.now()}`
  await writeAgent({
    id: agentId,
    name: composeAgentName(session.leafIds, answers),
    model: 'claude-sonnet-4-6',
    system: systemPrompt,
    tools: [],
    metadata: {
      'x-dc-leaves': session.leafIds,
      'x-dc-personality-preset': 'mentor',
      'x-dc-personality-sliders': {},
      'x-dc-coach-answers': answers,
      'x-dc-pattern': 'checker',
      'x-dc-archetype': 'role',  // legacy compat
    },
  })

  // Update the binding to point at the real agent
  await putBinding({ chatId, agentId, sessionId: session.sessionId, inheritClaudeMd: false, workingDir: process.cwd(), createdAt: new Date().toISOString() })

  // Trigger badge re-render (existing helper)
  await refreshAgentBadge(ctx, chatId, agentId)

  // Clear coach session
  appSessions.delete(chatId)

  // Post the first agent message — the model generates this from the new system prompt
  await ctx.subagentCache.dispatch(chatId, { text: '__bootstrap__', source: 'system' })
}
```

- [ ] **Step 4: Type-check + run all existing tests**

```bash
cd plugin && bun test
```

- [ ] **Step 5: Manual end-to-end smoke test**

With `DC_NEW_AGENT_FLOW=1`, run through the wall → mash-up → review → Build & start chatting → coach interview → graduation. Verify the chat avatar swaps after the last coach question.

- [ ] **Step 6: Commit**

```bash
git add plugin/apps/agent-setup-app.ts plugin/dispatcher/message-router.ts
git commit -m "feat(agent-setup): coach interview drives chat from build to graduation"
```

---

## Phase 9: Badge pattern variants (renderer)

### Task 9.1: Extend palettes.ts and renderer with seven new patterns

**Files:**
- Modify: `plugin/agent-icons/palettes.ts`
- Modify: `plugin/agent-icon-render.ts`
- Create: `plugin/test/badge-patterns.test.ts`

- [ ] **Step 1: Write the snapshot test**

Create `plugin/test/badge-patterns.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { renderAgentBadge, setBadgeCacheDir } from '../agent-icon-render.js'
import { mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Badge patterns', () => {
  beforeEach(() => {
    setBadgeCacheDir(mkdtempSync(join(tmpdir(), 'badges-')))
  })

  test.each([
    'checker',
    'mini-checker',
    'stripes',
    'v-stripes',
    'quartered',
    'quartered-x',
    'dots',
    'big-dots',
  ])('renders the %s pattern at all 3 tiers without throwing', async (pattern) => {
    for (const family of ['haiku', 'sonnet', 'opus'] as const) {
      const path = await renderAgentBadge({
        archetype: 'role',
        modelFamily: family,
        trust: true,
        glyph: 'user-round',
        pattern: pattern as any,
      })
      expect(statSync(path).size).toBeGreaterThan(1000)
    }
  })

  test('solid (trust-off) renders without a pattern', async () => {
    const path = await renderAgentBadge({
      archetype: 'role',
      modelFamily: 'sonnet',
      trust: false,
      glyph: 'user-round',
      pattern: 'checker',  // ignored when trust=false
    })
    expect(statSync(path).size).toBeGreaterThan(1000)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd plugin && bun test test/badge-patterns.test.ts
```

Expected: FAIL — `pattern` not on `BadgeInputs`.

- [ ] **Step 3: Add the pattern type and SVG builders**

Modify `plugin/agent-icons/palettes.ts` to export pattern names:

```typescript
export const PATTERN_IDS = ['checker', 'mini-checker', 'stripes', 'v-stripes', 'quartered', 'quartered-x', 'dots', 'big-dots'] as const
export type PatternId = (typeof PATTERN_IDS)[number]
```

Modify `plugin/agent-icon-render.ts`:

```typescript
import { PATTERN_IDS, type PatternId } from './agent-icons/palettes.js'

export interface BadgeInputs {
  archetype: Archetype
  modelFamily: ModelFamily
  trust: boolean
  glyph: string
  pattern: PatternId  // NEW
}

function uid(): string {
  return 'p' + Math.random().toString(36).slice(2, 9)
}

function patternDefs(pattern: PatternId, solid: string, accent: string): { defs: string; fill: string } {
  const id = uid()
  switch (pattern) {
    case 'checker':
      return { defs: `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="128" height="128"><rect width="64" height="64" fill="${solid}"/><rect x="64" width="64" height="64" fill="${accent}"/><rect y="64" width="64" height="64" fill="${accent}"/><rect x="64" y="64" width="64" height="64" fill="${solid}"/></pattern></defs>`, fill: `url(#${id})` }
    case 'mini-checker':
      return { defs: `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="64" height="64"><rect width="32" height="32" fill="${solid}"/><rect x="32" width="32" height="32" fill="${accent}"/><rect y="32" width="32" height="32" fill="${accent}"/><rect x="32" y="32" width="32" height="32" fill="${solid}"/></pattern></defs>`, fill: `url(#${id})` }
    case 'stripes':
      // 4 horizontal bands
      return { defs: '', fill: solid /* not used; we render rects directly */ }
    // ... (cases for v-stripes, quartered, quartered-x, dots, big-dots)
  }
  throw new Error(`unknown pattern: ${pattern}`)
}

// Refactor buildBadgeSvg to accept pattern instead of just `checker`:
function buildBadgeSvg(inner: string, solid: string, accent: string, pattern: PatternId, trust: boolean): string {
  if (!trust) {
    // Solid background
    return `<svg ...><g clip-path="url(#circle)"><rect width="256" height="256" fill="${solid}"/>...</g>...</svg>`
  }
  // Build pattern-specific fill SVG inline
  const fillSvg = buildPatternFill(pattern, solid, accent)
  return `<svg ...><g clip-path="url(#circle)">${fillSvg}<g transform="translate(64,64) scale(5.333)" stroke="#FAF9F5" stroke-width="3" fill="none">${inner}</g></g>...</svg>`
}

function buildPatternFill(pattern: PatternId, solid: string, accent: string): string {
  const id = uid()
  switch (pattern) {
    case 'checker': {
      return `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="128" height="128"><rect width="64" height="64" fill="${solid}"/><rect x="64" width="64" height="64" fill="${accent}"/><rect y="64" width="64" height="64" fill="${accent}"/><rect x="64" y="64" width="64" height="64" fill="${solid}"/></pattern></defs><rect width="256" height="256" fill="url(#${id})"/>`
    }
    case 'mini-checker': {
      return `<defs><pattern id="${id}" patternUnits="userSpaceOnUse" width="64" height="64"><rect width="32" height="32" fill="${solid}"/><rect x="32" width="32" height="32" fill="${accent}"/><rect y="32" width="32" height="32" fill="${accent}"/><rect x="32" y="32" width="32" height="32" fill="${solid}"/></pattern></defs><rect width="256" height="256" fill="url(#${id})"/>`
    }
    case 'stripes':
      return `<rect width="256" height="64" fill="${solid}"/><rect y="64" width="256" height="64" fill="${accent}"/><rect y="128" width="256" height="64" fill="${solid}"/><rect y="192" width="256" height="64" fill="${accent}"/>`
    case 'v-stripes':
      return `<rect width="64" height="256" fill="${solid}"/><rect x="64" width="64" height="256" fill="${accent}"/><rect x="128" width="64" height="256" fill="${solid}"/><rect x="192" width="64" height="256" fill="${accent}"/>`
    case 'quartered':
      return `<rect width="128" height="128" fill="${solid}"/><rect x="128" width="128" height="128" fill="${accent}"/><rect y="128" width="128" height="128" fill="${accent}"/><rect x="128" y="128" width="128" height="128" fill="${solid}"/>`
    case 'quartered-x':
      return `<rect width="256" height="256" fill="${solid}"/><polygon points="0,0 256,0 128,128" fill="${accent}"/><polygon points="0,256 256,256 128,128" fill="${accent}"/>`
    case 'dots': {
      let dots = ''
      for (let y = 32; y < 256; y += 64)
        for (let x = 32; x < 256; x += 64)
          dots += `<circle cx="${x}" cy="${y}" r="20" fill="${accent}"/>`
      return `<rect width="256" height="256" fill="${solid}"/>${dots}`
    }
    case 'big-dots': {
      let dots = ''
      for (let y = 64; y < 256; y += 128)
        for (let x = 64; x < 256; x += 128)
          dots += `<circle cx="${x}" cy="${y}" r="40" fill="${accent}"/>`
      return `<rect width="256" height="256" fill="${solid}"/>${dots}`
    }
  }
}
```

Update `cacheKey` to include the pattern:

```typescript
function cacheKey(i: BadgeInputs): string {
  const trust = i.trust ? 'trust' : 'plain'
  return `${i.archetype}-${i.modelFamily}-${trust}-${i.glyph}-${i.pattern}.png`
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/badge-patterns.test.ts
```

Expected: PASS (24 pattern × tier combinations + 1 solid = 25 sub-tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/agent-icon-render.ts plugin/agent-icons/palettes.ts plugin/test/badge-patterns.test.ts
git commit -m "feat(badges): seven new pattern variants (mini-checker, stripes, v-stripes, quartered, quartered-x, dots, big-dots)"
```

### Task 9.2: Surface pattern picker in the review screen

**Files:**
- Modify: `plugin/webxdc/agent-setup.html`
- Modify: `plugin/apps/agent-setup-app.ts`

- [ ] **Step 1: Add a pattern row to the review screen**

In the review screen rendering, just above the CTA row, add an 8-tile selector. Default selection: `checker`. The selected pattern is passed through to the `build-agent` payload.

- [ ] **Step 2: Honor `pattern` in `handleBuildAgent`**

Persist the pattern into `metadata['x-dc-pattern']` of the AgentDef and into `BadgeInputs` when refreshing the badge.

- [ ] **Step 3: Commit**

```bash
git add plugin/webxdc/agent-setup.html plugin/apps/agent-setup-app.ts
git commit -m "feat(agent-setup): pattern picker on review screen"
```

---

## Phase 10: NL controls (model switch / trust / refine)

### Task 10.1: Intent classifier module

**Files:**
- Create: `plugin/nl-intents.ts`
- Create: `plugin/test/nl-intents.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugin/test/nl-intents.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { classifyIntent } from '../nl-intents.js'

describe('NL intent classifier', () => {
  test.each([
    ['switch to sonnet', { kind: 'model-switch', tier: 'sonnet' }],
    ['use opus please', { kind: 'model-switch', tier: 'opus' }],
    ['can you downgrade to haiku', { kind: 'model-switch', tier: 'haiku' }],
    ['trust me', { kind: 'trust-toggle', value: true }],
    ['turn on trust', { kind: 'trust-toggle', value: true }],
    ['skip permissions', { kind: 'trust-toggle', value: true }],
    ['be safer', { kind: 'trust-toggle', value: false }],
    ['turn off trust', { kind: 'trust-toggle', value: false }],
    ['ask before tools', { kind: 'trust-toggle', value: false }],
    ["let's refine you", { kind: 'refine' }],
    ['I want to tweak your prompt', { kind: 'refine' }],
    ['be sharper on the math', { kind: 'refine' }],
  ])('classifies %s', (input, expected) => {
    const got = classifyIntent(input)
    expect(got).toMatchObject(expected as object)
  })

  test('returns null for unrelated text', () => {
    expect(classifyIntent('what is the capital of france?')).toBeNull()
    expect(classifyIntent('thanks!')).toBeNull()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd plugin && bun test test/nl-intents.test.ts
```

- [ ] **Step 3: Implement the classifier**

Create `plugin/nl-intents.ts`:

```typescript
export type Intent =
  | { kind: 'model-switch'; tier: 'haiku' | 'sonnet' | 'opus' }
  | { kind: 'trust-toggle'; value: boolean }
  | { kind: 'refine' }
  | null

const MODEL_RE = /\b(?:switch|use|change|move|downgrade|upgrade|swap|set)\b.*\b(haiku|sonnet|opus)\b/i
const MODEL_BARE_RE = /\b(haiku|sonnet|opus)\b/i

const TRUST_ON_RE = /\b(trust\s+me|turn\s+on\s+trust|enable\s+trust|skip\s+permissions?)\b/i
const TRUST_OFF_RE = /\b(be\s+safer|turn\s+off\s+trust|disable\s+trust|ask\s+(?:me\s+)?before|require\s+permission)/i

const REFINE_RE = /\b(refine|tweak|adjust|sharpen|update|change|edit)\b.*\b(you|prompt|behavior|tone|style|approach)/i
const REFINE_DIRECT_RE = /\b(let'?s\s+refine|let'?s\s+tweak|i\s+want\s+to\s+(?:tweak|refine|change))\b/i
const REFINE_DIRECTIVE_RE = /\bbe\s+(?:more|less|sharper|gentler|stricter|kinder|terser|chattier)\b/i

export function classifyIntent(text: string): Intent {
  const t = text.trim()
  // Trust on (check before model switch — "trust me" doesn't mention a tier)
  if (TRUST_ON_RE.test(t)) return { kind: 'trust-toggle', value: true }
  if (TRUST_OFF_RE.test(t)) return { kind: 'trust-toggle', value: false }
  // Model switch
  let m = t.match(MODEL_RE)
  if (m) return { kind: 'model-switch', tier: m[1].toLowerCase() as 'haiku' | 'sonnet' | 'opus' }
  // Refine
  if (REFINE_DIRECT_RE.test(t)) return { kind: 'refine' }
  if (REFINE_RE.test(t)) return { kind: 'refine' }
  if (REFINE_DIRECTIVE_RE.test(t)) return { kind: 'refine' }
  return null
}
```

- [ ] **Step 4: Run tests**

```bash
cd plugin && bun test test/nl-intents.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add plugin/nl-intents.ts plugin/test/nl-intents.test.ts
git commit -m "feat(nl-intents): classifier for model-switch / trust-toggle / refine"
```

### Task 10.2: Wire intents into the dispatcher pipeline

**Files:**
- Modify: `plugin/dispatcher/message-router.ts`
- Modify: `plugin/agents.ts` (add helpers)

- [ ] **Step 1: Add `setAgentModel` and `setAgentTrust` helpers in `agents.ts`**

```typescript
export async function setAgentModel(agentId: string, tier: 'haiku' | 'sonnet' | 'opus') {
  const def = await loadAgent(agentId)
  if (!def) return
  def.model = LATEST_MODELS[tier]
  await writeAgent(def)
}

export async function setAgentTrust(agentId: string, value: boolean) {
  const def = await loadAgent(agentId)
  if (!def) return
  def.metadata = { ...(def.metadata ?? {}), 'x-dc-skipPermissions': value }
  await writeAgent(def)
}

const LATEST_MODELS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-7',
}
```

- [ ] **Step 2: Hook intent classifier before dispatch in `message-router.ts`**

```typescript
import { classifyIntent } from '../nl-intents.js'
import { setAgentModel, setAgentTrust } from '../agents.js'

// In the dispatch path, before subagentCache.dispatch:
const intent = classifyIntent(message.text || '')
if (intent) {
  switch (intent.kind) {
    case 'model-switch': {
      const binding = getBinding(chatId)
      if (!binding) break
      await setAgentModel(binding.agentId, intent.tier)
      await refreshAgentBadge(ctx, chatId, binding.agentId)
      await client.send(chatId, `Switched to ${intent.tier} — I'll feel about the same with the new pacing.`)
      return
    }
    case 'trust-toggle': {
      const binding = getBinding(chatId)
      if (!binding) break
      await setAgentTrust(binding.agentId, intent.value)
      await refreshAgentBadge(ctx, chatId, binding.agentId)
      await client.send(chatId, intent.value
        ? 'Trust on — I\'ll skip permission prompts for tools.'
        : 'Trust off — I\'ll ask before running tools.')
      return
    }
    case 'refine': {
      await startRefineFlow(ctx, chatId)
      return
    }
  }
}
```

- [ ] **Step 3: Implement `startRefineFlow`**

(Stub for now; full implementation in Phase 11.)

```typescript
async function startRefineFlow(ctx: AppContext, chatId: number) {
  await client.send(chatId, 'Coming up — what would you like to change about how I work?')
  // Phase 11: actually load the existing prompt as coach context, run a focused interview,
  // and rewrite the affected blocks via the assembler.
}
```

- [ ] **Step 4: Manual smoke test**

In a paired chat with an agent: type "switch to opus" — expect badge color change. Type "trust me" — expect badge to fill with the pattern. Type "let's refine you" — expect placeholder Refine response.

- [ ] **Step 5: Commit**

```bash
git add plugin/dispatcher/message-router.ts plugin/agents.ts
git commit -m "feat(nl): wire intent classifier to model/trust handlers (refine stub)"
```

---

## Phase 11: Refine + home IA + cleanup

### Task 11.1: Add the Refine card to home IA

**Files:**
- Modify: `plugin/webxdc/agent-setup.html`

- [ ] **Step 1: Add the Refine action card to `#step0`**

Insert between Manage and Resume:

```html
<button class="home-action" onclick="gotoRefine()">
  <span class="home-action-icon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>
  </span>
  <span class="home-action-body">
    <span class="home-action-label">Refine an agent</span>
    <span class="home-action-desc">Coach-guided shaping of an existing agent.</span>
  </span>
  <span class="home-action-chev" aria-hidden="true">&rsaquo;</span>
</button>
```

- [ ] **Step 2: Add the divider between agent-shaping and session-device groups**

Wrap the first three actions in a `<div class="home-group">` and the last three in another, with a hairline rule between:

```css
.home-group { display: flex; flex-direction: column; gap: 8px; }
.home-group + .home-group { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 4px; }
```

- [ ] **Step 3: Implement `gotoRefine()` to show an agent picker (subset of Manage)**

```javascript
function gotoRefine() {
  state.refinePicker = true
  show('refine-picker')
  renderRefinePickList()
}
```

- [ ] **Step 4: Commit**

```bash
git add plugin/webxdc/agent-setup.html
git commit -m "feat(agent-setup): Refine card on home + agent-shaping group divider"
```

### Task 11.2: Implement the full Refine coach flow

**Files:**
- Modify: `plugin/coach.ts` (add `startRefineCoach`)
- Modify: `plugin/dispatcher/message-router.ts` (full Refine impl)

- [ ] **Step 1: Add `startRefineCoach` that loads existing prompt as context**

In `plugin/coach.ts` (the `RefineInputs` interface was added in Task 5.1):

```typescript
export function startRefineCoach(inputs: RefineInputs): CoachState {
  const state: CoachState = {
    inputs: { leafIds: [], preset: 'mentor', sliders: {} },
    remaining: [
      {
        id: 'refine-ask',
        question: () => 'What would you like to change about how I work?',
        capture: (s, a) => { s.answers.preferences.push(a) },
      },
    ],
    answers: { parameters: {}, preferences: [], tools: [] },
    nextQuestion: 'What would you like to change about how I work?',
    lastReflection: null,
    warnings: [],
  }
  // Stash the existing prompt for the assembler to incorporate
  state.refineContext = inputs
  return state
}
```

- [ ] **Step 2: Implement incremental rewrite in the assembler**

Add `refineSystemPrompt(existing: string, changes: CoachAnswers): string` that parses the 5 paragraphs, modifies only the Voice and Preferences paragraphs based on changes, and returns the new prompt.

- [ ] **Step 3: Wire to message-router**

Replace the Refine stub from Phase 10:

```typescript
async function startRefineFlow(ctx: AppContext, chatId: number) {
  const binding = getBinding(chatId)
  if (!binding) return
  const agent = await loadAgent(binding.agentId)
  if (!agent) return
  const coachState = startRefineCoach({ agentId: agent.id, existingPrompt: agent.system })
  appSessions.set(chatId, { coachState, leafIds: agent.metadata['x-dc-leaves'] ?? [], sessionId: binding.sessionId, refining: true })
  if (coachState.nextQuestion) {
    await client.send(chatId, coachState.nextQuestion)
  }
}
```

When the coach completes (`isCoachDone`), call `refineSystemPrompt` and write back the AgentDef. Same `sessionId`, same chat, no badge swap (just a "Done — incorporated." reply).

- [ ] **Step 4: Tests**

Add `plugin/test/coach.test.ts` cases for `startRefineCoach`. Add `plugin/test/prompt-assembler.test.ts` cases for `refineSystemPrompt`.

- [ ] **Step 5: Commit**

```bash
git add plugin/coach.ts plugin/prompt-assembler.ts plugin/dispatcher/message-router.ts plugin/test/
git commit -m "feat(refine): full coach-led refine flow with incremental rewrite"
```

### Task 11.3: Flip `DC_NEW_AGENT_FLOW` to default-on, deprecate template-grid path

**Files:**
- Modify: `plugin/apps/agent-setup-app.ts`

- [ ] **Step 1: Default `enabled: true` if env var unset**

```typescript
newAgentFlow: {
  enabled: process.env.DC_NEW_AGENT_FLOW !== '0',
  // ...
}
```

- [ ] **Step 2: Mark v1.x template-grid path as legacy in code comments**

Add a TODO comment at the top of the legacy `gotoNewChat → renderTemplates` path indicating it's only kept for users who set `DC_NEW_AGENT_FLOW=0` and will be removed in a future release.

- [ ] **Step 3: Update CLAUDE.md to reflect the new default flow**

(Project-level CLAUDE.md has a section on the agent-setup card. Update to describe the wall + coach + mash-up architecture and reference this spec.)

- [ ] **Step 4: Commit**

```bash
git add plugin/apps/agent-setup-app.ts CLAUDE.md
git commit -m "feat(agent-setup): make new flow default; legacy gated by DC_NEW_AGENT_FLOW=0"
```

### Task 11.4: End-to-end happy-path test

**Files:**
- Create: `plugin/test/agent-creation-e2e.test.ts`

- [ ] **Step 1: Write a Bun integration test that exercises the full path**

Stub the DC client and the subagent cache. Walk through:
1. User taps "Start a new chat" on the home card → wall renders
2. User searches "sleep" → results show Sleep coach
3. User selects Sleep coach + Stress + Mindfulness via pairs-with chips
4. User taps Build & start chatting
5. Coach asks lead question; user answers
6. Coach asks voice question; user answers
7. Coach asks tools question; user answers
8. Graduation triggers; AgentDef has 5-paragraph system prompt with all leaves named, the user's preferences embedded, and the medical liability frame

Assertions:
- `appSessions.delete(chatId)` was called
- A real `AgentDef` was written
- The badge cache contains a non-coach badge for the chat
- `client.send` was called for each coach question + the final agent bootstrap

- [ ] **Step 2: Run the test**

```bash
cd plugin && bun test test/agent-creation-e2e.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add plugin/test/agent-creation-e2e.test.ts
git commit -m "test(e2e): full agent-creation happy path (wall → coach → graduation)"
```

### Task 11.5: Update CLAUDE.md & cut release

- [ ] **Step 1: Update CLAUDE.md project section on Agent setup**

(Project root `CLAUDE.md` has a long section on the agent setup app. Update to describe the new flow, link to the spec under `plugin/docs/superpowers/specs/`, and note that Phase 11 made the new flow default.)

- [ ] **Step 2: Bump plugin version + update CHANGELOG**

- [ ] **Step 3: Run the full test suite + the Tier-1 WebXDC tests**

```bash
cd plugin && bun test
cd plugin/test/webxdc && bun run test
```

- [ ] **Step 4: Commit + release**

```bash
git add CLAUDE.md plugin/package.json plugin/CHANGELOG.md
git commit -m "release: agent-creation redesign v1"
git tag v1.2.0
```

---

## Self-Review

**Spec coverage check.** Walked the spec section-by-section against this plan:
- §1 Goals: covered by Phases 1-11 collectively.
- §2 Non-goals: respected (no migration, no advice, no marketplace).
- §3 Concept model: leaves (Phase 1), mash-up (Phase 7), coach (Phase 5), refine (Phase 11), personality (Phase 3), trust (Phase 9, 10), model tier (Phase 10), tools (Phase 5).
- §4 User journey: Phase 6, 7, 8 cover wall → mash-up → review → coach → graduation; Phase 10 covers NL.
- §5 Ontology: Phase 1 + Phase 2 (155 leaves authored).
- §6 Home IA: Phase 11 (Refine card, group divider).
- §7 Navigation CX: Phase 6.
- §8 Mash-up CX: Phase 7.
- §9 Coach: Phase 5 (state machine), Phase 8 (integration).
- §10 NL controls: Phase 10.
- §11 System-prompt assembly: Phase 4.
- §12 Personality: Phase 3.
- §13 Tools: Phase 5 (coach captures), Phase 8 (assembler embeds).
- §14 Liability: Phase 3.
- §15 Badge: Phase 9.
- §16 Storage: implicit in Phase 8 (writeAgent + putBinding).
- §17 Open questions: deferred to implementation as the spec called for; Phases 5, 8, 9, 10, 11 each touch one.
- §18 Glossary: not implementation work.

**Placeholder scan.** A few places intentionally defer detail because they are large authoring tasks:
- Task 2.2 says "author each L2 group, one commit per group" without inlining 154 expertise paragraphs. This is appropriate — the engineer needs the *pattern* (Task 2.1) and the *batching strategy*, not 800 KB of paragraph text in the plan.
- Task 6.4 references "follow the pattern in `permission-prompt.test.ts`" without inlining ~100 lines of Playwright. This is appropriate when the pattern is established and tracked in a sibling file.

No "TBD" or "TODO" or "implement later" placeholders that block execution.

**Type consistency.** `BadgeInputs.pattern` is added in Task 9.1 and used in Task 9.2. `CoachState.refineContext` is referenced in Task 11.2 — needs to be added to the `CoachState` interface in that task. Adding inline:

```typescript
// in plugin/coach.ts, modify CoachState:
export interface CoachState {
  inputs: CoachInputs
  remaining: QuestionStep[]
  answers: CoachAnswers
  nextQuestion: string | null
  lastReflection: string | null
  warnings: string[]
  refineContext?: RefineInputs  // set when state was created via startRefineCoach
}
```

Add this field in Task 5.1 alongside the rest of `CoachState` so Task 11.2 doesn't need to extend the interface mid-flight.

**Scope check.** This is a single cohesive feature with phased delivery. Each phase ships working software guarded by `DC_NEW_AGENT_FLOW`. The catalog (Phases 1-2) can ship and be queried before any UI exists. The static-text modules (Phase 3) and the assembler (Phase 4) can be tested in isolation. The UI work (Phases 6-7) and the integration work (Phase 8) can be exercised against a single chat manually. The badge work (Phase 9) is decoupled from the rest. NL controls (Phase 10) and Refine (Phase 11) build on what came before.

The plan is large because the spec is large. Decomposing into separate plan files would only fragment the dependencies — nothing here can be built without the catalog loader, and nothing useful ships without the coach.

---

**Plan complete and saved to `plugin/docs/superpowers/plans/2026-04-28-agent-creation-redesign.md`.** Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
