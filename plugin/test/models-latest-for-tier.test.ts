import { test, expect } from 'bun:test'
import { latestModelForTier, tierForModel } from '../models'

test('latestModelForTier returns the newest id for each tier', () => {
  expect(latestModelForTier('opus')).toBe('claude-opus-4-7')
  expect(latestModelForTier('sonnet')).toBe('claude-sonnet-4-6')
  expect(latestModelForTier('haiku')).toBe('claude-haiku-4-5')
})

// v1.4.11 — tierForModel must accept any user-typed model id and infer
// its tier from the claude-<tier>-<N>-<N> prefix when the id isn't in
// the curated manifest. Non-Anthropic ids (gpt-4, llama-…) return
// 'unknown' so the badge renderer falls through to UNKNOWN_MODEL_COLOR.

test('tierForModel: manifest-first lookup wins over regex', () => {
  expect(tierForModel('claude-opus-4-7')).toBe('opus')
  expect(tierForModel('claude-sonnet-4-6')).toBe('sonnet')
  expect(tierForModel('claude-haiku-4-5')).toBe('haiku')
})

test('tierForModel: extracts tier from claude-<tier>-<N>-<N> IDs not in manifest', () => {
  expect(tierForModel('claude-fable-1-0')).toBe('fable')
  expect(tierForModel('claude-zephyr-3-2')).toBe('zephyr')
})

test('tierForModel: case-insensitive regex extract, returns lowercase', () => {
  expect(tierForModel('Claude-Fable-1-0')).toBe('fable')
})

test('tierForModel: returns "unknown" for IDs that do not match claude-<tier>- pattern', () => {
  expect(tierForModel('gpt-4')).toBe('unknown')
  expect(tierForModel('llama-3-70b')).toBe('unknown')
  expect(tierForModel('')).toBe('unknown')
})
