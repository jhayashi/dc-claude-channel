import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSessionTranscript, projectHashForCwd, setProjectsRoot } from '../resume'

let root: string
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

describe('readSessionTranscript', () => {
  test('returns the jsonl contents for an existing session', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-resume-'))
    setProjectsRoot(root)
    const cwd = '/work/dir'
    const dir = join(root, projectHashForCwd(cwd))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess-1.jsonl'), 'line1\nline2\n')
    expect(readSessionTranscript(cwd, 'sess-1')).toBe('line1\nline2\n')
  })
  test('returns empty string when the file is absent', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-resume-'))
    setProjectsRoot(root)
    expect(readSessionTranscript('/no/such', 'missing')).toBe('')
  })
})
