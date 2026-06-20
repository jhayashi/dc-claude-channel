import { test, expect } from 'bun:test'
import { getTeleportVersion } from '../teleport.js'

test('teleport build module reports a numeric APP_VERSION from the HTML', () => {
  const v = getTeleportVersion()
  expect(typeof v).toBe('number')
  expect(v).toBeGreaterThanOrEqual(1.0)
})
