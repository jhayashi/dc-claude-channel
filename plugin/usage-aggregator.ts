/**
 * Aggregates Claude Code token usage from on-disk session transcripts.
 *
 * Source of truth: `~/.claude/projects/<project>/<sessionId>.jsonl`. Every
 * `type: "assistant"` line carries a `message.usage` object with raw API
 * token counts. This module walks those files, sums per-model totals
 * (`aggregateEntries`) or buckets them by local date (`aggregateByDay`),
 * and renders a chat-friendly report. The chart in `slash-handler.ts`
 * reads the per-day series directly from transcripts — there is no longer
 * a dependency on the CLI's `stats-cache.json` (deprecated in 2.1.118).
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Daily-series types
// ---------------------------------------------------------------------------

export interface DailyTokenEntry {
  date: string  // YYYY-MM-DD (local)
  tokensByModel: Record<string, number>
}

/** Returns the last N entries of a daily series, sorted ascending by date. */
export function lastNDays(daily: DailyTokenEntry[], n: number): DailyTokenEntry[] {
  return [...daily].sort((a, b) => a.date.localeCompare(b.date)).slice(-n)
}

/** Local-date YYYY-MM-DD (matches the bucketing the CLI's stats-cache uses). */
export function localDateString(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Date object at 00:00 local time on the given day (default today). */
export function startOfDay(d: Date = new Date()): Date {
  const out = new Date(d)
  out.setHours(0, 0, 0, 0)
  return out
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssistantEntry {
  timestamp: string
  sessionId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface UsageReport {
  perModel: Record<string, ModelUsage>
  totalSessions: number
  totalMessages: number
  earliestTs?: string
  latestTs?: string
  /** ISO timestamp of the filter cutoff, when entries were time-filtered. */
  sinceTs?: string
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

/** Aggregates parsed assistant entries into a usage report, optionally filtering to entries at/after `since`. */
export function aggregateEntries(entries: AssistantEntry[], since?: Date): UsageReport {
  const perModel: Record<string, ModelUsage> = {}
  const sessions = new Set<string>()
  const sinceMs = since ? since.getTime() : -Infinity
  let earliestMs = Infinity
  let latestMs = -Infinity
  let messageCount = 0

  for (const e of entries) {
    const ts = Date.parse(e.timestamp)
    if (Number.isFinite(ts) && ts < sinceMs) continue

    const slot = perModel[e.model] ?? (perModel[e.model] = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    })
    slot.inputTokens += e.inputTokens
    slot.outputTokens += e.outputTokens
    slot.cacheReadTokens += e.cacheReadTokens
    slot.cacheCreationTokens += e.cacheCreationTokens

    sessions.add(e.sessionId)
    messageCount++

    if (Number.isFinite(ts)) {
      if (ts < earliestMs) earliestMs = ts
      if (ts > latestMs) latestMs = ts
    }
  }

  return {
    perModel,
    totalSessions: sessions.size,
    totalMessages: messageCount,
    earliestTs: Number.isFinite(earliestMs) ? new Date(earliestMs).toISOString() : undefined,
    latestTs: Number.isFinite(latestMs) ? new Date(latestMs).toISOString() : undefined,
    sinceTs: since?.toISOString(),
  }
}

/**
 * Buckets entries into per-day per-model totals (input + output only — cache
 * reads/writes are excluded because they dominate counts 10-50× and would
 * make today's bar visually dwarf cached prior days). Bucketing key is the
 * local-date YYYY-MM-DD of the entry's timestamp. Returns the series sorted
 * ascending by date.
 */
export function aggregateByDay(entries: AssistantEntry[], since?: Date): DailyTokenEntry[] {
  const sinceMs = since ? since.getTime() : -Infinity
  const buckets = new Map<string, Record<string, number>>()
  for (const e of entries) {
    const ts = Date.parse(e.timestamp)
    if (Number.isFinite(ts) && ts < sinceMs) continue
    const date = localDateString(new Date(ts))
    const slot = buckets.get(date) ?? {}
    slot[e.model] = (slot[e.model] ?? 0) + e.inputTokens + e.outputTokens
    buckets.set(date, slot)
  }
  const out: DailyTokenEntry[] = []
  for (const [date, tokensByModel] of buckets) out.push({ date, tokensByModel })
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

// ---------------------------------------------------------------------------
// Parsing (pure)
// ---------------------------------------------------------------------------

interface RawTranscriptLine {
  type?: string
  timestamp?: string
  sessionId?: string
  message?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

/** Parses a single jsonl line; returns null if it isn't an assistant turn with usage. */
export function parseLine(line: string): AssistantEntry | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let d: RawTranscriptLine
  try {
    d = JSON.parse(trimmed) as RawTranscriptLine
  } catch {
    return null
  }
  if (d.type !== 'assistant') return null
  if (!d.message?.usage || !d.message.model || !d.timestamp || !d.sessionId) return null
  // <synthetic> entries are bookkeeping turns (compacts etc.) with no real usage.
  if (d.message.model === '<synthetic>') return null
  const u = d.message.usage
  return {
    timestamp: d.timestamp,
    sessionId: d.sessionId,
    model: d.message.model,
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Disk loading
// ---------------------------------------------------------------------------

/** Walks the projects dir and returns every parsed assistant entry, mtime-prefiltered by `since` when supplied. */
export async function loadUsageEntries(projectsDir: string, since?: Date): Promise<AssistantEntry[]> {
  const entries: AssistantEntry[] = []
  let projectDirs: string[]
  try {
    projectDirs = await readdir(projectsDir)
  } catch {
    return entries
  }

  for (const project of projectDirs) {
    const projectPath = join(projectsDir, project)
    let s
    try {
      s = await stat(projectPath)
    } catch {
      continue
    }
    if (!s.isDirectory()) continue

    let files: string[]
    try {
      files = await readdir(projectPath)
    } catch {
      continue
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const filePath = join(projectPath, file)

      // mtime prefilter: when a `since` cutoff is set, files last modified
      // before it can't contain entries newer than it.
      if (since) {
        try {
          const fs = await stat(filePath)
          if (fs.mtimeMs < since.getTime()) continue
        } catch {
          continue
        }
      }

      let raw: string
      try {
        raw = await readFile(filePath, 'utf8')
      } catch {
        continue
      }
      for (const line of raw.split('\n')) {
        const entry = parseLine(line)
        if (entry) entries.push(entry)
      }
    }
  }

  return entries
}

/** Convenience wrapper: load + aggregate in one call. */
export async function loadUsageReport(projectsDir: string, since?: Date): Promise<UsageReport> {
  return aggregateEntries(await loadUsageEntries(projectsDir, since), since)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return `${n}`
}

function totalTokens(m: ModelUsage): number {
  return m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheCreationTokens
}

function shortModel(model: string): string {
  return model.replace('claude-', '').replace(/-\d{8}$/, '')
}

// ---------------------------------------------------------------------------
// Chart rendering (SVG)
// ---------------------------------------------------------------------------

/**
 * Family-based color so new model versions stay visually consistent.
 * Sourced from the Technical Precision design system (~/Documents):
 * Anthropic Orange (#D97757), Kelly Green (#2E9147), Deep Amber (#B4862A),
 * with slate-300 as the unknown-model fallback.
 */
function colorForModel(model: string): string {
  if (model.includes('opus')) return '#D97757'    // Anthropic Orange
  if (model.includes('sonnet')) return '#2E9147'  // Kelly Green
  if (model.includes('haiku')) return '#B4862A'   // Deep Amber
  return '#9AA5B8'                                 // slate-300
}

function svgEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  )
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const exp = Math.floor(Math.log10(v))
  const base = Math.pow(10, exp)
  const n = v / base
  const rounded = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return rounded * base
}

/**
 * Renders a stacked-bar chart of daily tokens per model as an SVG string.
 * One bar per day (oldest → newest left → right), models stacked within
 * each bar, legend on the right.
 */
export function renderDailyTokensSVG(
  daily: DailyTokenEntry[],
  opts: { width?: number; height?: number } = {},
): string {
  const W = opts.width ?? 800
  const H = opts.height ?? 360
  const margin = { top: 24, right: 180, bottom: 56, left: 72 }
  const plotW = W - margin.left - margin.right
  const plotH = H - margin.top - margin.bottom

  // Discover models, ordered by total tokens descending so the largest
  // sits at the bottom of each stack.
  const totals: Record<string, number> = {}
  for (const d of daily) {
    for (const [model, tokens] of Object.entries(d.tokensByModel)) {
      totals[model] = (totals[model] ?? 0) + tokens
    }
  }
  const models = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([m]) => m)

  // Per-day stack totals, used for Y scaling.
  const dayTotals = daily.map(d => Object.values(d.tokensByModel).reduce((a, b) => a + b, 0))
  const yMaxRaw = Math.max(1, ...dayTotals)
  const yMax = niceMax(yMaxRaw)

  const barCount = Math.max(1, daily.length)
  const slotW = plotW / barCount
  const barW = Math.min(slotW * 0.7, 60)

  // Technical Precision palette: warm paper canvas + slate ink/chrome.
  const BG = '#FAF9F5'        // Off-White
  const INK = '#343C4D'       // Slate (brand)
  const AXIS_LABEL = '#4A5467' // slate-500
  const Y_LABEL = '#6B7689'   // slate-400
  const GRID = '#E3E7EE'      // slate-100
  const AXIS_LINE = '#C7CEDB' // slate-200

  const out: string[] = []
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">`)
  out.push(`<rect width="${W}" height="${H}" fill="${BG}"/>`)
  out.push(`<text x="${margin.left}" y="16" font-weight="600" font-size="14" fill="${INK}">Tokens per day · last ${daily.length} days</text>`)

  // Y grid + labels (5 lines including 0 and yMax).
  const gridSteps = 4
  for (let i = 0; i <= gridSteps; i++) {
    const v = (yMax / gridSteps) * i
    const y = margin.top + plotH - (v / yMax) * plotH
    out.push(`<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="${GRID}"/>`)
    out.push(`<text x="${margin.left - 8}" y="${y + 4}" text-anchor="end" fill="${Y_LABEL}">${formatTokenCount(v)}</text>`)
  }

  // Bars: stack models bottom-up.
  daily.forEach((d, i) => {
    const xCenter = margin.left + slotW * (i + 0.5)
    const x = xCenter - barW / 2
    let yCursor = margin.top + plotH
    for (const model of [...models].reverse()) {
      const v = d.tokensByModel[model] ?? 0
      if (v <= 0) continue
      const h = (v / yMax) * plotH
      yCursor -= h
      out.push(`<rect x="${x}" y="${yCursor}" width="${barW}" height="${h}" fill="${colorForModel(model)}"/>`)
    }
    // X-axis date label (MM-DD).
    const label = svgEscape(d.date.slice(5))
    out.push(`<text x="${xCenter}" y="${margin.top + plotH + 18}" text-anchor="middle" fill="${AXIS_LABEL}">${label}</text>`)
  })

  // X axis line.
  out.push(`<line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="${AXIS_LINE}"/>`)

  // Legend.
  const lx = margin.left + plotW + 16
  models.forEach((model, i) => {
    const ly = margin.top + i * 22
    out.push(`<rect x="${lx}" y="${ly}" width="14" height="14" fill="${colorForModel(model)}"/>`)
    out.push(`<text x="${lx + 20}" y="${ly + 11}" fill="${INK}">${svgEscape(model.replace('claude-', '').replace(/-\d{8}$/, ''))}</text>`)
  })

  out.push(`</svg>`)
  return out.join('\n')
}

export function formatUsageReport(r: UsageReport): string {
  if (r.totalMessages === 0) {
    return r.sinceTs
      ? `No usage data since ${r.sinceTs.slice(0, 10)}.`
      : 'No usage data found.'
  }

  const lines: string[] = []
  if (r.sinceTs) {
    lines.push(`Since:    ${r.sinceTs.slice(0, 10)}`)
  } else if (r.earliestTs && r.latestTs) {
    lines.push(`Range:    ${r.earliestTs.slice(0, 10)} → ${r.latestTs.slice(0, 10)}`)
  }
  lines.push(`Sessions: ${r.totalSessions.toLocaleString()}`)
  lines.push(`Messages: ${r.totalMessages.toLocaleString()}`)

  const models = Object.entries(r.perModel).sort((a, b) => totalTokens(b[1]) - totalTokens(a[1]))
  if (models.length > 0) {
    lines.push('')
    lines.push('By model:')
    for (const [model, m] of models) {
      lines.push(
        `  ${shortModel(model)} — ${formatTokenCount(totalTokens(m))} tokens` +
        ` (in ${formatTokenCount(m.inputTokens)}, out ${formatTokenCount(m.outputTokens)},` +
        ` cache r ${formatTokenCount(m.cacheReadTokens)}, w ${formatTokenCount(m.cacheCreationTokens)})`
      )
    }
  }

  return lines.join('\n')
}
