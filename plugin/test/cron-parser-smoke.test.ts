import { describe, test, expect } from 'bun:test'
import { CronExpressionParser } from 'cron-parser'

describe('cron-parser smoke', () => {
  test('parses a standard 5-field expression', () => {
    const iter = CronExpressionParser.parse('0 9 * * 1-5', {
      currentDate: new Date('2026-04-13T08:00:00Z'),
      tz: 'UTC',
    })
    const next = iter.next().toDate()
    expect(next.getUTCHours()).toBe(9)
  })

  test('rejects malformed expressions', () => {
    expect(() => CronExpressionParser.parse('not a cron')).toThrow()
  })

  test('next() after now skips missed fires', () => {
    const iter = CronExpressionParser.parse('* * * * *', {
      currentDate: new Date('2026-04-13T10:00:30Z'),
      tz: 'UTC',
    })
    const next = iter.next().toDate()
    expect(next.toISOString()).toBe('2026-04-13T10:01:00.000Z')
  })
})
