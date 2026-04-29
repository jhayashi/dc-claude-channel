/**
 * One-off export: read the v0.4.1 catalog CSV (path, l2_domain, leaf,
 * parameter, liability, combines_with, pitch, notes), emit one YAML file
 * per leaf into plugin/leaves/. Run with: bun run plugin/leaves-export.ts <csv-path>
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function parseCsv(text: string): Record<string, string>[] {
  // Small CSV parser; handles quoted fields with commas + escaped quotes.
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

// Clean stale outputs so renames/removals in the CSV don't leave phantom leaves.
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.yaml')) unlinkSync(join(outDir, f))
}

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
