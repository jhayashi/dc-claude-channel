import { test, expect } from 'bun:test'
import { latestModelForTier, tierForModel } from '../models'

test('latestModelForTier returns the newest id for each tier', () => {
  // Opus 5 / Sonnet 5 listed first in models.json (newest-first per tier
  // convention) → latestModelForTier returns them over the retained 4.x
  // entries. Fable 5 is its own tier so it returns claude-fable-5.
  expect(latestModelForTier('opus')).toBe('claude-opus-5')
  expect(latestModelForTier('sonnet')).toBe('claude-sonnet-5')
  expect(latestModelForTier('haiku')).toBe('claude-haiku-4-5')
  expect(latestModelForTier('fable')).toBe('claude-fable-5')
})

// v1.4.11 — tierForModel must accept any user-typed model id and infer
// its tier from the claude-<tier>-<N>-<N> prefix when the id isn't in
// the curated manifest. Non-Anthropic ids (gpt-4, llama-…) return
// 'unknown' so the badge renderer falls through to UNKNOWN_MODEL_COLOR.

test('tierForModel: manifest-first lookup wins over regex', () => {
  expect(tierForModel('claude-opus-4-8')).toBe('opus')
  expect(tierForModel('claude-opus-4-7')).toBe('opus')
  expect(tierForModel('claude-sonnet-4-6')).toBe('sonnet')
  expect(tierForModel('claude-haiku-4-5')).toBe('haiku')
  expect(tierForModel('claude-fable-5')).toBe('fable')
})

test('tierForModel: extracts tier from claude-<tier>-<N> IDs not in manifest', () => {
  expect(tierForModel('claude-zephyr-3-2')).toBe('zephyr')
  // claude-mythos-5 is invitation-only (Project Glasswing) — not in our
  // curated manifest, but the regex extracts its tier correctly.
  expect(tierForModel('claude-mythos-5')).toBe('mythos')
})

test('tierForModel: case-insensitive regex extract, returns lowercase', () => {
  expect(tierForModel('Claude-Fable-1-0')).toBe('fable')
})

test('tierForModel: returns "unknown" for IDs that do not match claude-<tier>- pattern', () => {
  expect(tierForModel('gpt-4')).toBe('unknown')
  expect(tierForModel('llama-3-70b')).toBe('unknown')
  expect(tierForModel('')).toBe('unknown')
})
