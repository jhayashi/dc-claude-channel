/**
 * Shared result-reporting helper for Phase 1 spikes.
 *
 * Every spike calls writeReport() once at the end with pass/fail and
 * a structured set of evidence rows. Reports land at
 * plugin/spikes/results/<id>.md and are committed to git so the
 * go/no-go decision is auditable.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

export interface SpikeResult {
  id: string
  title: string
  passed: boolean
  verdict: string
  evidence: Array<{ label: string; value: string }>
  notes?: string
}

export function writeReport(result: SpikeResult): void {
  const path = join(import.meta.dir, '..', 'results', `${result.id}.md`)
  mkdirSync(dirname(path), { recursive: true })

  const lines: string[] = []
  lines.push(`# Spike ${result.id}: ${result.title}`)
  lines.push('')
  lines.push(`**Verdict:** ${result.passed ? '✅ PASS' : '❌ FAIL'} — ${result.verdict}`)
  lines.push('')
  lines.push('## Evidence')
  lines.push('')
  lines.push('| Measurement | Value |')
  lines.push('|---|---|')
  for (const row of result.evidence) {
    lines.push(`| ${row.label} | ${row.value} |`)
  }
  if (result.notes) {
    lines.push('')
    lines.push('## Notes')
    lines.push('')
    lines.push(result.notes)
  }
  lines.push('')

  writeFileSync(path, lines.join('\n'))
  console.log(`Wrote ${path}`)
}

export function exitFromResult(result: SpikeResult): never {
  writeReport(result)
  process.exit(result.passed ? 0 : 1)
}
