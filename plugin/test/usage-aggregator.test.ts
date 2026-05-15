import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  aggregateByDay,
  aggregateEntries,
  formatTokenCount,
  formatUsageReport,
  lastNDays,
  loadUsageReport,
  localDateString,
  parseLine,
  renderDailyTokensSVG,
  startOfDay,
  type AssistantEntry,
  type DailyTokenEntry,
} from '../usage-aggregator'

// ---------------------------------------------------------------------------
// formatTokenCount
// ---------------------------------------------------------------------------

describe('formatTokenCount', () => {
  test.each<[number, string]>([
    [0, '0'],
    [999, '999'],
    [1_000, '1K'],
    [1_500, '2K'],
    [1_000_000, '1.0M'],
    [1_234_567, '1.2M'],
    [1_000_000_000, '1.0B'],
    [5_700_000_000, '5.7B'],
  ])('%d → %s', (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// parseLine
// ---------------------------------------------------------------------------

describe('parseLine', () => {
  test('returns null for empty/whitespace lines', () => {
    expect(parseLine('')).toBeNull()
    expect(parseLine('  \n')).toBeNull()
  })

  test('returns null for malformed JSON', () => {
    expect(parseLine('{not json')).toBeNull()
  })

  test('returns null for non-assistant entries', () => {
    expect(parseLine(JSON.stringify({ type: 'user', timestamp: 'x', sessionId: 'y' }))).toBeNull()
  })

  test('returns null when usage is missing', () => {
    expect(parseLine(JSON.stringify({
      type: 'assistant', timestamp: 't', sessionId: 's',
      message: { model: 'claude-opus-4-7' },
    }))).toBeNull()
  })

  test('parses a complete assistant entry', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-01T12:00:00.000Z',
      sessionId: 'sess-1',
      message: {
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 1000,
        },
      },
    })
    expect(parseLine(line)).toEqual({
      timestamp: '2026-05-01T12:00:00.000Z',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-6',
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 5000,
      cacheCreationTokens: 1000,
    })
  })

  test('defaults missing token fields to 0', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: 't', sessionId: 's',
      message: { model: 'claude-haiku-4-5', usage: { input_tokens: 50 } },
    })
    const e = parseLine(line)!
    expect(e.outputTokens).toBe(0)
    expect(e.cacheReadTokens).toBe(0)
    expect(e.cacheCreationTokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// aggregateEntries
// ---------------------------------------------------------------------------

function entry(overrides: Partial<AssistantEntry> = {}): AssistantEntry {
  return {
    timestamp: '2026-05-01T12:00:00.000Z',
    sessionId: 'sess-1',
    model: 'claude-sonnet-4-6',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    ...overrides,
  }
}

describe('aggregateEntries', () => {
  test('empty input → zero report', () => {
    const r = aggregateEntries([])
    expect(r.totalMessages).toBe(0)
    expect(r.totalSessions).toBe(0)
    expect(r.earliestTs).toBeUndefined()
    expect(r.latestTs).toBeUndefined()
  })

  test('sums per-model token totals', () => {
    const r = aggregateEntries([
      entry({ model: 'claude-opus-4-7', inputTokens: 1000, outputTokens: 500 }),
      entry({ model: 'claude-opus-4-7', inputTokens: 2000, outputTokens: 1000 }),
      entry({ model: 'claude-sonnet-4-6', inputTokens: 5000, outputTokens: 1000 }),
    ])
    expect(r.perModel['claude-opus-4-7'].inputTokens).toBe(3000)
    expect(r.perModel['claude-opus-4-7'].outputTokens).toBe(1500)
    expect(r.perModel['claude-sonnet-4-6'].inputTokens).toBe(5000)
  })

  test('counts unique sessions', () => {
    const r = aggregateEntries([
      entry({ sessionId: 'a' }),
      entry({ sessionId: 'a' }),
      entry({ sessionId: 'b' }),
      entry({ sessionId: 'c' }),
    ])
    expect(r.totalSessions).toBe(3)
    expect(r.totalMessages).toBe(4)
  })

  test('tracks earliest and latest timestamps across all entries', () => {
    const r = aggregateEntries([
      entry({ timestamp: '2026-05-01T12:00:00.000Z' }),
      entry({ timestamp: '2026-04-15T08:00:00.000Z' }),
      entry({ timestamp: '2026-05-02T20:00:00.000Z' }),
    ])
    expect(r.earliestTs).toBe('2026-04-15T08:00:00.000Z')
    expect(r.latestTs).toBe('2026-05-02T20:00:00.000Z')
  })

  test('filters out entries before `since`', () => {
    const since = new Date('2026-05-01T00:00:00.000Z')
    const r = aggregateEntries([
      entry({ sessionId: 'old',  timestamp: '2026-04-15T08:00:00.000Z', inputTokens: 999 }),
      entry({ sessionId: 'new1', timestamp: '2026-05-01T12:00:00.000Z', inputTokens: 100 }),
      entry({ sessionId: 'new2', timestamp: '2026-05-02T20:00:00.000Z', inputTokens: 200 }),
    ], since)
    expect(r.totalMessages).toBe(2)
    expect(r.totalSessions).toBe(2)
    expect(r.perModel['claude-sonnet-4-6'].inputTokens).toBe(300)
    expect(r.sinceTs).toBe(since.toISOString())
  })

  test('returns empty report when nothing falls in window', () => {
    const since = new Date('2027-01-01T00:00:00.000Z')
    const r = aggregateEntries([entry()], since)
    expect(r.totalMessages).toBe(0)
    expect(r.sinceTs).toBe(since.toISOString())
  })
})

// ---------------------------------------------------------------------------
// aggregateByDay
// ---------------------------------------------------------------------------

/** Build an ISO timestamp that, when bucketed via localDateString, lands on the given local YYYY-MM-DD. */
function localTs(year: number, month: number, day: number, hour = 12): string {
  return new Date(year, month - 1, day, hour, 0, 0).toISOString()
}

describe('aggregateByDay', () => {
  test('empty input → empty series', () => {
    expect(aggregateByDay([])).toEqual([])
  })

  test('buckets by local date and sums input + output only (cache tokens excluded)', () => {
    const series = aggregateByDay([
      entry({ timestamp: localTs(2026, 5, 1), model: 'opus', inputTokens: 100, outputTokens: 50, cacheReadTokens: 10_000, cacheCreationTokens: 500 }),
      entry({ timestamp: localTs(2026, 5, 1), model: 'opus', inputTokens: 200, outputTokens: 25 }),
      entry({ timestamp: localTs(2026, 5, 2), model: 'sonnet', inputTokens: 500 }),
    ])
    expect(series).toEqual([
      { date: '2026-05-01', tokensByModel: { opus: 375 } },  // 150 + 225, cache reads ignored
      { date: '2026-05-02', tokensByModel: { sonnet: 500 } },
    ])
  })

  test('keeps models separate on the same day', () => {
    const series = aggregateByDay([
      entry({ timestamp: localTs(2026, 5, 1), model: 'opus',   inputTokens: 100 }),
      entry({ timestamp: localTs(2026, 5, 1), model: 'sonnet', inputTokens: 200 }),
    ])
    expect(series).toEqual([
      { date: '2026-05-01', tokensByModel: { opus: 100, sonnet: 200 } },
    ])
  })

  test('returns series sorted ascending by date regardless of input order', () => {
    const series = aggregateByDay([
      entry({ timestamp: localTs(2026, 5, 3), inputTokens: 30 }),
      entry({ timestamp: localTs(2026, 5, 1), inputTokens: 10 }),
      entry({ timestamp: localTs(2026, 5, 2), inputTokens: 20 }),
    ])
    expect(series.map(d => d.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03'])
  })

  test('filters entries before `since`', () => {
    const since = new Date(localTs(2026, 5, 1, 0))
    const series = aggregateByDay([
      entry({ timestamp: localTs(2026, 4, 30, 12), inputTokens: 999 }),
      entry({ timestamp: localTs(2026, 5, 1, 12),  inputTokens: 100 }),
    ], since)
    expect(series).toHaveLength(1)
    expect(series[0].date).toBe('2026-05-01')
  })
})

// ---------------------------------------------------------------------------
// formatUsageReport
// ---------------------------------------------------------------------------

describe('formatUsageReport', () => {
  test('empty report → "no usage data" message', () => {
    const out = formatUsageReport(aggregateEntries([]))
    expect(out).toMatch(/no usage data/i)
  })

  test('shows "Since" header when window is filtered', () => {
    const out = formatUsageReport(aggregateEntries(
      [entry({ timestamp: '2026-05-02T12:00:00.000Z' })],
      new Date('2026-05-01T00:00:00.000Z'),
    ))
    expect(out).toContain('Since')
    expect(out).toContain('2026-05-01')
    expect(out).not.toContain('Range')
  })

  test('includes totals and per-model rows', () => {
    const out = formatUsageReport(aggregateEntries([
      entry({ model: 'claude-opus-4-7', inputTokens: 100_000, outputTokens: 50_000, sessionId: 'a' }),
      entry({ model: 'claude-sonnet-4-6', inputTokens: 200_000, outputTokens: 100_000, sessionId: 'b' }),
    ]))
    expect(out).toContain('Sessions')
    expect(out).toContain('Messages')
    expect(out).toContain('opus-4-7')
    expect(out).toContain('sonnet-4-6')
  })

  test('does not show cost or wall duration', () => {
    const out = formatUsageReport(aggregateEntries([
      entry({ model: 'claude-opus-4-7', inputTokens: 100_000 }),
    ]))
    expect(out).not.toMatch(/\$/)
    expect(out).not.toMatch(/duration/i)
  })

  test('strips date suffix from model labels', () => {
    const out = formatUsageReport(aggregateEntries([
      entry({ model: 'claude-haiku-4-5-20251001', inputTokens: 1000 }),
    ]))
    expect(out).toContain('haiku-4-5')
    expect(out).not.toContain('20251001')
  })

  test('models are sorted by total tokens descending', () => {
    const out = formatUsageReport(aggregateEntries([
      entry({ model: 'claude-haiku-4-5', inputTokens: 100, sessionId: 'a' }),
      entry({ model: 'claude-opus-4-7', inputTokens: 1_000_000, sessionId: 'b' }),
    ]))
    expect(out.indexOf('opus-4-7')).toBeLessThan(out.indexOf('haiku-4-5'))
  })
})

// ---------------------------------------------------------------------------
// loadUsageReport (disk integration)
// ---------------------------------------------------------------------------

const fixtureDir = mkdtempSync(join(tmpdir(), 'dc-usage-fixture-'))

beforeAll(() => {
  // Two project dirs, each with one session jsonl, plus some non-jsonl noise.
  const p1 = join(fixtureDir, 'project-one')
  const p2 = join(fixtureDir, 'project-two')
  mkdirSync(p1, { recursive: true })
  mkdirSync(p2, { recursive: true })

  const lines1 = [
    JSON.stringify({ type: 'user', timestamp: 't', sessionId: 's1' }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-01T10:00:00.000Z',
      sessionId: 's1',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 50 } },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-01T10:05:00.000Z',
      sessionId: 's1',
      message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 200, output_tokens: 75 } },
    }),
    '',  // blank line
    'not json at all',  // garbage, should be skipped
  ].join('\n')
  writeFileSync(join(p1, 's1.jsonl'), lines1)
  writeFileSync(join(p1, 'README.md'), 'should be ignored')

  const lines2 = JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-01T11:00:00.000Z',
    sessionId: 's2',
    message: { model: 'claude-opus-4-7', usage: { input_tokens: 500, output_tokens: 250 } },
  })
  writeFileSync(join(p2, 's2.jsonl'), lines2)
})

afterAll(() => {
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe('loadUsageReport', () => {
  test('aggregates across multiple project dirs and session files', async () => {
    const r = await loadUsageReport(fixtureDir)
    expect(r.totalMessages).toBe(3)
    expect(r.totalSessions).toBe(2)
    expect(r.perModel['claude-sonnet-4-6'].inputTokens).toBe(300)
    expect(r.perModel['claude-opus-4-7'].inputTokens).toBe(500)
  })

  test('returns empty report when projects dir does not exist', async () => {
    const r = await loadUsageReport('/tmp/no-such-dir-xyz-999')
    expect(r.totalMessages).toBe(0)
    expect(r.totalSessions).toBe(0)
  })

  test('skips non-jsonl files and malformed lines without throwing', async () => {
    const r = await loadUsageReport(fixtureDir)
    // README.md and the garbage line should not raise; all valid entries counted.
    expect(r.totalMessages).toBe(3)
  })

  test('mtime prefilter skips files older than `since` without reading them', async () => {
    // Backdate s1.jsonl's mtime to before the window so the read is skipped
    // entirely. Even though its in-file timestamps would otherwise match, the
    // prefilter cuts it out before parsing.
    const oldMtime = new Date('2025-01-01T00:00:00.000Z')
    utimesSync(join(fixtureDir, 'project-one', 's1.jsonl'), oldMtime, oldMtime)
    const since = new Date('2026-01-01T00:00:00.000Z')

    const r = await loadUsageReport(fixtureDir, since)
    // Only s2.jsonl (project-two, fresh mtime) survives the prefilter.
    expect(r.totalMessages).toBe(1)
    expect(r.perModel['claude-sonnet-4-6']).toBeUndefined()
    expect(r.perModel['claude-opus-4-7']?.inputTokens).toBe(500)
  })
})

// ---------------------------------------------------------------------------
// lastNDays
// ---------------------------------------------------------------------------

describe('lastNDays', () => {
  const series: DailyTokenEntry[] = [
    { date: '2026-04-25', tokensByModel: {} },
    { date: '2026-04-26', tokensByModel: {} },
    { date: '2026-04-27', tokensByModel: {} },
    { date: '2026-04-28', tokensByModel: {} },
  ]

  test('returns last N entries sorted ascending', () => {
    const out = lastNDays(series, 2)
    expect(out.map(d => d.date)).toEqual(['2026-04-27', '2026-04-28'])
  })

  test('handles N larger than series length', () => {
    expect(lastNDays(series, 99).length).toBe(4)
  })

  test('sorts unsorted input by date', () => {
    const unsorted: DailyTokenEntry[] = [
      { date: '2026-04-28', tokensByModel: {} },
      { date: '2026-04-25', tokensByModel: {} },
      { date: '2026-04-27', tokensByModel: {} },
    ]
    expect(lastNDays(unsorted, 2).map(d => d.date)).toEqual(['2026-04-27', '2026-04-28'])
  })
})

// ---------------------------------------------------------------------------
// renderDailyTokensSVG
// ---------------------------------------------------------------------------

describe('localDateString / startOfDay', () => {
  test('localDateString formats as YYYY-MM-DD in local time', () => {
    // Construct a date with explicit local fields.
    const d = new Date(2026, 4, 2, 14, 30)  // 2026-05-02 14:30 local
    expect(localDateString(d)).toBe('2026-05-02')
  })

  test('startOfDay returns midnight local time', () => {
    const d = new Date(2026, 4, 2, 14, 30, 45)
    const m = startOfDay(d)
    expect(m.getHours()).toBe(0)
    expect(m.getMinutes()).toBe(0)
    expect(m.getDate()).toBe(2)
  })
})


describe('renderDailyTokensSVG', () => {
  test('produces a valid SVG envelope', () => {
    const out = renderDailyTokensSVG([{ date: '2026-05-01', tokensByModel: { 'claude-opus-4-7': 100 } }])
    expect(out).toMatch(/^<svg /)
    expect(out).toMatch(/<\/svg>$/)
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"')
  })

  test('renders one bar per day', () => {
    const out = renderDailyTokensSVG([
      { date: '2026-04-30', tokensByModel: { 'claude-opus-4-7': 100 } },
      { date: '2026-05-01', tokensByModel: { 'claude-opus-4-7': 200 } },
      { date: '2026-05-02', tokensByModel: { 'claude-opus-4-7': 150 } },
    ])
    // 3 bars + 1 axis line + grid lines + legend swatch = many <rect>s,
    // but date labels are unique per bar.
    expect(out).toContain('>04-30<')
    expect(out).toContain('>05-01<')
    expect(out).toContain('>05-02<')
  })

  test('legend lists each model exactly once', () => {
    const out = renderDailyTokensSVG([
      { date: '2026-05-01', tokensByModel: { 'claude-opus-4-7': 100, 'claude-sonnet-4-6': 50 } },
      { date: '2026-05-02', tokensByModel: { 'claude-opus-4-7': 200, 'claude-sonnet-4-6': 25 } },
    ])
    expect(out.match(/>opus-4-7</g)?.length).toBe(1)
    expect(out.match(/>sonnet-4-6</g)?.length).toBe(1)
  })

  test('escapes XML-unsafe characters in model names', () => {
    const out = renderDailyTokensSVG([
      { date: '2026-05-01', tokensByModel: { 'claude-<weird>-name': 100 } },
    ])
    expect(out).not.toContain('<weird>')
    expect(out).toContain('&lt;weird&gt;')
  })

  test('handles empty series without crashing', () => {
    const out = renderDailyTokensSVG([])
    expect(out).toMatch(/^<svg /)
  })
})
