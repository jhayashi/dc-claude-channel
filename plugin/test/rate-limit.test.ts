import { test, expect } from 'bun:test'
import { RateLimiter } from '../dispatcher/rate-limit.js'

test('allows up to limit then blocks', () => {
  let now = 1_000_000
  const rl = new RateLimiter({ limit: 5, windowMs: 60_000, now: () => now })
  for (let i = 0; i < 5; i++) expect(rl.check(42)).toBe(true)
  expect(rl.check(42)).toBe(false)
  expect(rl.check(42)).toBe(false)
})

test('per-chat isolation: one chat over budget does not affect another', () => {
  let now = 1_000_000
  const rl = new RateLimiter({ limit: 2, windowMs: 60_000, now: () => now })
  expect(rl.check(1)).toBe(true)
  expect(rl.check(1)).toBe(true)
  expect(rl.check(1)).toBe(false)
  expect(rl.check(2)).toBe(true)
  expect(rl.check(2)).toBe(true)
  expect(rl.check(2)).toBe(false)
})

test('window slides: old entries expire and budget refills', () => {
  let now = 1_000_000
  const rl = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now })
  expect(rl.check(7)).toBe(true)
  expect(rl.check(7)).toBe(true)
  expect(rl.check(7)).toBe(true)
  expect(rl.check(7)).toBe(false)
  // Advance just past the window — all three entries expire.
  now += 60_001
  expect(rl.check(7)).toBe(true)
  expect(rl.size(7)).toBe(1)
})

test('partial window slide: only expired entries drop', () => {
  let now = 1_000_000
  const rl = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now })
  expect(rl.check(9)).toBe(true) // t=1_000_000
  now += 30_000
  expect(rl.check(9)).toBe(true) // t=1_030_000
  expect(rl.check(9)).toBe(true) // t=1_030_000
  expect(rl.check(9)).toBe(false)
  // Advance past first entry only (t > 1_060_000) but not second/third.
  now = 1_060_500
  expect(rl.check(9)).toBe(true)
  expect(rl.size(9)).toBe(3) // two from t=1_030_000 + one new
})
