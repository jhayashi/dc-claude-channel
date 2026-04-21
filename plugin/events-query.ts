/**
 * Read side of the event log. Enumerates per-day JSONL files in
 * $DC_EVENT_DIR, parses each line, and applies filters. Powers the
 * `dc_show_events` tool — kept separate from events.ts (which owns the
 * write side) so the query logic can be unit-tested in isolation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getEventDir } from './events.js'

export type EventStream = 'tools' | 'turns' | 'permissions' | 'webxdc'
export const ALL_STREAMS: EventStream[] = ['tools', 'turns', 'permissions', 'webxdc']

/**
 * Parse a `since` value. Accepts `<N>h` (hours) or `<N>d` (days) as a
 * relative offset from `now`, or any ISO-8601 timestamp `Date.parse` can
 * read. Throws on bad input.
 */
export function parseSince(value: string, now: Date = new Date()): Date {
  const m = /^(\d+)([hd])$/.exec(value)
  if (m) {
    const n = Number(m[1])
    const unitMs = m[2] === 'h' ? 3600_000 : 86400_000
    return new Date(now.getTime() - n * unitMs)
  }
  const t = Date.parse(value)
  if (Number.isFinite(t)) return new Date(t)
  throw new Error(`invalid since: ${value}`)
}

/**
 * Expected file paths for one stream covering `[since, now]` inclusive.
 * Filenames follow the UTC-date convention in events.ts; this function
 * does NOT check existence — callers `existsSync` before opening.
 */
export function listEventFilesForStream(
  dir: string,
  stream: EventStream,
  since: Date,
  now: Date = new Date(),
): string[] {
  const files: string[] = []
  const startDay = Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())
  const endDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  for (let t = startDay; t <= endDay; t += 86400_000) {
    const d = new Date(t)
    const y = d.getUTCFullYear()
    const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
    const da = String(d.getUTCDate()).padStart(2, '0')
    files.push(join(dir, `${stream}-${y}-${mo}-${da}.log`))
  }
  return files
}

export interface QueryOptions {
  streams: EventStream[]
  since: Date
  /** Filter for tools stream only (matched against `tool` field). */
  tool?: string
  /** When true, drop non-error events. See isError() for per-stream rules. */
  onlyErrors?: boolean
  /** Hard cap on returned hits (most recent kept). Default 500. */
  limit?: number
}

export interface EventHit {
  stream: EventStream
  ts: string
  /** Parsed event object. */
  obj: Record<string, unknown>
}

/**
 * Per-stream classifier for `only_errors`. Tools: ok=false. Permissions:
 * verdict=deny. WebXDC: ownerVerified=false. Turns: exit reasons that
 * indicate something went wrong (crash, turn_timeout, resume_fallback).
 * Normal lifecycle exits (completed/idle/lru_evict/user_abort) are NOT
 * errors.
 */
function isError(stream: EventStream, obj: Record<string, unknown>): boolean {
  if (stream === 'tools') return obj.ok === false
  if (stream === 'permissions') return obj.verdict === 'deny'
  if (stream === 'webxdc') return obj.ownerVerified === false
  if (stream === 'turns') {
    const r = obj.exitReason
    return r === 'crash' || r === 'turn_timeout' || r === 'resume_fallback'
  }
  return false
}

/**
 * Read, parse, filter, sort. Returns events across all requested
 * streams sorted by ts ascending. Missing files and malformed lines are
 * silently skipped — observability should never throw.
 */
export function queryEvents(opts: QueryOptions, dir: string = getEventDir()): EventHit[] {
  const sinceMs = opts.since.getTime()
  const hits: EventHit[] = []
  for (const stream of opts.streams) {
    for (const path of listEventFilesForStream(dir, stream, opts.since)) {
      if (!existsSync(path)) continue
      let data: string
      try { data = readFileSync(path, 'utf8') } catch { continue }
      for (const line of data.split('\n')) {
        if (!line) continue
        let obj: Record<string, unknown>
        try { obj = JSON.parse(line) } catch { continue }
        const ts = obj.ts
        if (typeof ts !== 'string') continue
        const tMs = Date.parse(ts)
        if (!Number.isFinite(tMs) || tMs < sinceMs) continue
        if (opts.tool && stream === 'tools' && obj.tool !== opts.tool) continue
        if (opts.onlyErrors && !isError(stream, obj)) continue
        hits.push({ stream, ts, obj })
      }
    }
  }
  hits.sort((a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)
  const limit = opts.limit ?? 500
  if (hits.length > limit) return hits.slice(hits.length - limit)
  return hits
}

/**
 * Render hits as a markdown doc suitable for dc_send_file. Each stream
 * gets a heading and a fenced `jsonl` block; empty streams are omitted.
 * The outer shape is chosen for the file-reviewer — line-oriented,
 * easy to long-press on a specific event to leave a comment.
 */
export function renderEventsMarkdown(
  hits: EventHit[],
  opts: { since: Date; streams: EventStream[]; tool?: string; onlyErrors?: boolean },
): string {
  const filters: string[] = []
  filters.push(`since ${opts.since.toISOString()}`)
  if (opts.tool) filters.push(`tool=${opts.tool}`)
  if (opts.onlyErrors) filters.push('only_errors=true')
  const header = `# DC events\n\n- filters: ${filters.join(', ')}\n- streams: ${opts.streams.join(', ')}\n- matched: ${hits.length}\n\n`
  if (hits.length === 0) return header + '_No events in window._\n'
  const byStream = new Map<EventStream, EventHit[]>()
  for (const h of hits) {
    const arr = byStream.get(h.stream) ?? []
    arr.push(h)
    byStream.set(h.stream, arr)
  }
  let out = header
  for (const stream of opts.streams) {
    const arr = byStream.get(stream)
    if (!arr || arr.length === 0) continue
    out += `## ${stream} (${arr.length})\n\n\`\`\`jsonl\n`
    for (const h of arr) out += JSON.stringify(h.obj) + '\n'
    out += '```\n\n'
  }
  return out
}
