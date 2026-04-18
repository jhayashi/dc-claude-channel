import { test, expect } from 'bun:test'
import { latestModelForTier } from '../models'

test('latestModelForTier returns the newest id for each tier', () => {
  expect(latestModelForTier('opus')).toBe('claude-opus-4-7')
  expect(latestModelForTier('sonnet')).toBe('claude-sonnet-4-6')
  expect(latestModelForTier('haiku')).toBe('claude-haiku-4-5')
})
