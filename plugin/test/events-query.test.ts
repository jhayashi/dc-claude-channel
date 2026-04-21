import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  parseSince,
  listEventFilesForStream,
  queryEvents,
  renderEventsMarkdown,
  ALL_STREAMS,
} from '../events-query.js'

describe('events-query.parseSince', () => {
  it('parses <N>h relative windows', () => {
    const now = new Date('2026-04-20T12:00:00.000Z')
    expect(parseSince('1h', now).toISOString()).toBe('2026-04-20T11:00:00.000Z')
    expect(parseSince('24h', now).toISOString()).toBe('2026-04-19T12:00:00.000Z')
  })

  it('parses <N>d relative windows', () => {
    const now = new Date('2026-04-20T12:00:00.000Z')
    expect(parseSince('7d', now).toISOString()).toBe('2026-04-13T12:00:00.000Z')
  })

  it('accepts ISO-8601 timestamps verbatim', () => {
    const now = new Date('2026-04-20T12:00:00.000Z')
    expect(parseSince('2026-04-19T00:00:00.000Z', now).toISOString()).toBe('2026-04-19T00:00:00.000Z')
  })

  it('throws on invalid input', () => {
    expect(() => parseSince('bogus')).toThrow(/invalid since/)
    expect(() => parseSince('not-a-date')).toThrow(/invalid since/)
    expect(() => parseSince('')).toThrow(/invalid since/)
  })
})

describe('events-query.listEventFilesForStream', () => {
  it('covers the date range inclusive on both ends', () => {
    const since = new Date('2026-04-18T23:00:00.000Z')
    const now = new Date('2026-04-20T01:00:00.000Z')
    const files = listEventFilesForStream('/tmp', 'tools', since, now)
    expect(files).toEqual([
      '/tmp/tools-2026-04-18.log',
      '/tmp/tools-2026-04-19.log',
      '/tmp/tools-2026-04-20.log',
    ])
  })

  it('returns a single file when since and now fall on the same UTC day', () => {
    const since = new Date('2026-04-20T01:00:00.000Z')
    const now = new Date('2026-04-20T23:00:00.000Z')
    const files = listEventFilesForStream('/tmp', 'turns', since, now)
    expect(files).toEqual(['/tmp/turns-2026-04-20.log'])
  })
})

describe('events-query.queryEvents', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'events-query-test-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  const write = (file: string, ...lines: unknown[]) => {
    writeFileSync(join(dir, file), lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  }

  it('returns hits sorted by ts ascending across streams', () => {
    write('tools-2026-04-20.log',
      { ts: '2026-04-20T10:00:00.000Z', tool: 'a', ok: true },
      { ts: '2026-04-20T12:00:00.000Z', tool: 'b', ok: true },
    )
    write('turns-2026-04-20.log',
      { ts: '2026-04-20T11:00:00.000Z', turnId: 't1', exitReason: 'completed' },
    )
    const hits = queryEvents({
      streams: [...ALL_STREAMS],
      since: new Date('2026-04-20T00:00:00.000Z'),
    }, dir)
    expect(hits.map(h => h.ts)).toEqual([
      '2026-04-20T10:00:00.000Z',
      '2026-04-20T11:00:00.000Z',
      '2026-04-20T12:00:00.000Z',
    ])
    expect(hits.map(h => h.stream)).toEqual(['tools', 'turns', 'tools'])
  })

  it('drops events older than the since cutoff', () => {
    write('tools-2026-04-20.log',
      { ts: '2026-04-20T09:00:00.000Z', tool: 'old', ok: true },
      { ts: '2026-04-20T11:00:00.000Z', tool: 'new', ok: true },
    )
    const hits = queryEvents({
      streams: ['tools'],
      since: new Date('2026-04-20T10:00:00.000Z'),
    }, dir)
    expect(hits.length).toBe(1)
    expect(hits[0].obj.tool).toBe('new')
  })

  it('filters by tool name on the tools stream only', () => {
    write('tools-2026-04-20.log',
      { ts: '2026-04-20T10:00:00.000Z', tool: 'dc_send', ok: true },
      { ts: '2026-04-20T11:00:00.000Z', tool: 'dc_read', ok: true },
    )
    write('turns-2026-04-20.log',
      { ts: '2026-04-20T10:30:00.000Z', turnId: 't1', tool: 'dc_send', exitReason: 'completed' },
    )
    const hits = queryEvents({
      streams: ['tools', 'turns'],
      since: new Date('2026-04-20T00:00:00.000Z'),
      tool: 'dc_send',
    }, dir)
    // Tool filter applies to tools stream only — turns pass through unfiltered.
    expect(hits.length).toBe(2)
    expect(hits.find(h => h.stream === 'tools')?.obj.tool).toBe('dc_send')
    expect(hits.find(h => h.stream === 'turns')).toBeDefined()
  })

  it('only_errors keeps tools ok=false / permissions deny / webxdc unverified / turns crash', () => {
    write('tools-2026-04-20.log',
      { ts: '2026-04-20T10:00:00.000Z', tool: 'a', ok: true },
      { ts: '2026-04-20T10:01:00.000Z', tool: 'b', ok: false, errorCode: 'tool_crash' },
    )
    write('permissions-2026-04-20.log',
      { ts: '2026-04-20T10:02:00.000Z', verdict: 'allow', reason: 'user_allow' },
      { ts: '2026-04-20T10:03:00.000Z', verdict: 'deny', reason: 'user_deny' },
    )
    write('webxdc-2026-04-20.log',
      { ts: '2026-04-20T10:04:00.000Z', ownerVerified: true },
      { ts: '2026-04-20T10:05:00.000Z', ownerVerified: false },
    )
    write('turns-2026-04-20.log',
      { ts: '2026-04-20T10:06:00.000Z', turnId: 'ok', exitReason: 'completed' },
      { ts: '2026-04-20T10:07:00.000Z', turnId: 'bad', exitReason: 'crash' },
      { ts: '2026-04-20T10:08:00.000Z', turnId: 'to', exitReason: 'turn_timeout' },
      { ts: '2026-04-20T10:09:00.000Z', turnId: 'ua', exitReason: 'user_abort' },
    )
    const hits = queryEvents({
      streams: [...ALL_STREAMS],
      since: new Date('2026-04-20T00:00:00.000Z'),
      onlyErrors: true,
    }, dir)
    const keys = hits.map(h => `${h.stream}:${(h.obj.tool ?? h.obj.verdict ?? h.obj.ownerVerified ?? h.obj.turnId)}`)
    expect(keys).toEqual([
      'tools:b',
      'permissions:deny',
      'webxdc:false',
      'turns:bad',
      'turns:to',
    ])
  })

  it('skips malformed JSON lines without throwing', () => {
    writeFileSync(join(dir, 'tools-2026-04-20.log'),
      '{"ts":"2026-04-20T10:00:00.000Z","tool":"a","ok":true}\nnot json\n{"ts":"2026-04-20T10:01:00.000Z","tool":"b","ok":true}\n',
    )
    const hits = queryEvents({
      streams: ['tools'],
      since: new Date('2026-04-20T00:00:00.000Z'),
    }, dir)
    expect(hits.length).toBe(2)
  })

  it('silently ignores missing files', () => {
    const hits = queryEvents({
      streams: ['tools'],
      since: new Date('2026-04-20T00:00:00.000Z'),
    }, dir)
    expect(hits).toEqual([])
  })

  it('caps results via limit, keeping the most recent', () => {
    const lines: string[] = []
    for (let i = 0; i < 10; i++) {
      lines.push(JSON.stringify({ ts: `2026-04-20T10:0${i}:00.000Z`, tool: `t${i}`, ok: true }))
    }
    writeFileSync(join(dir, 'tools-2026-04-20.log'), lines.join('\n') + '\n')
    const hits = queryEvents({
      streams: ['tools'],
      since: new Date('2026-04-20T00:00:00.000Z'),
      limit: 3,
    }, dir)
    expect(hits.map(h => h.obj.tool)).toEqual(['t7', 't8', 't9'])
  })
})

describe('events-query.renderEventsMarkdown', () => {
  it('emits header + per-stream fenced blocks', () => {
    const since = new Date('2026-04-20T00:00:00.000Z')
    const md = renderEventsMarkdown([
      { stream: 'tools', ts: '2026-04-20T10:00:00.000Z', obj: { ts: '2026-04-20T10:00:00.000Z', tool: 'a' } },
      { stream: 'turns', ts: '2026-04-20T10:01:00.000Z', obj: { ts: '2026-04-20T10:01:00.000Z', turnId: 't1' } },
    ], { since, streams: [...ALL_STREAMS] })
    expect(md).toContain('# DC events')
    expect(md).toContain('matched: 2')
    expect(md).toContain('## tools (1)')
    expect(md).toContain('## turns (1)')
    expect(md).toContain('```jsonl')
    expect(md).not.toContain('## permissions')
  })

  it('reports empty state when no hits', () => {
    const since = new Date('2026-04-20T00:00:00.000Z')
    const md = renderEventsMarkdown([], { since, streams: ['tools'] })
    expect(md).toContain('No events in window')
  })

  it('lists active filters in the header', () => {
    const since = new Date('2026-04-20T00:00:00.000Z')
    const md = renderEventsMarkdown([], {
      since,
      streams: ['tools'],
      tool: 'dc_send',
      onlyErrors: true,
    })
    expect(md).toContain('tool=dc_send')
    expect(md).toContain('only_errors=true')
  })
})
