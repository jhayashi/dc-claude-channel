import { describe, test, expect } from 'bun:test'
import { langFromPath } from '../apps/file-reviewer-app'

describe('langFromPath', () => {
  test('yaml extensions', () => {
    expect(langFromPath('/tmp/foo.yaml')).toBe('yaml')
    expect(langFromPath('/tmp/foo.yml')).toBe('yaml')
    expect(langFromPath('agent.YAML')).toBe('yaml')
  })

  test('json extensions', () => {
    expect(langFromPath('package.json')).toBe('json')
    expect(langFromPath('tsconfig.jsonc')).toBe('json')
  })

  test('common source extensions', () => {
    expect(langFromPath('app.ts')).toBe('typescript')
    expect(langFromPath('app.tsx')).toBe('typescript')
    expect(langFromPath('app.js')).toBe('javascript')
    expect(langFromPath('app.mjs')).toBe('javascript')
    expect(langFromPath('script.py')).toBe('python')
    expect(langFromPath('run.sh')).toBe('bash')
    expect(langFromPath('main.go')).toBe('go')
    expect(langFromPath('lib.rs')).toBe('rust')
  })

  test('markdown maps to markdown (caller may ignore to render instead)', () => {
    expect(langFromPath('README.md')).toBe('markdown')
    expect(langFromPath('notes.markdown')).toBe('markdown')
  })

  test('special basenames without extension', () => {
    expect(langFromPath('/repo/Dockerfile')).toBe('docker')
    expect(langFromPath('/repo/Makefile')).toBe('makefile')
    expect(langFromPath('dockerfile')).toBe('docker')
  })

  test('unknown or missing extension', () => {
    expect(langFromPath('LICENSE')).toBeUndefined()
    expect(langFromPath('/tmp/random.xyz')).toBeUndefined()
    expect(langFromPath('foo.')).toBeUndefined()
  })

  test('handles bare filenames and nested paths', () => {
    expect(langFromPath('foo.yaml')).toBe('yaml')
    expect(langFromPath('/a/b/c/foo.yaml')).toBe('yaml')
  })
})
