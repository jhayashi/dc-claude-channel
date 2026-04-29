import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { LeafSchema, type Leaf } from '../leaves.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadAllLeaves,
  setLeavesDir,
  findLeaf,
  leavesByPath,
  leavesByL2,
  symmetricCombines,
} from '../leaves.js'

describe('LeafSchema', () => {
  test('parses a minimal leaf', () => {
    const raw = {
      id: 'sleep-coach',
      path: 'Expert',
      l2: 'Health, wellness, caregiving',
      name: 'Sleep coach',
      pitch: 'Diagnoses your sleep with you, designs a sleep-hygiene plan, and tracks results. Can monitor your tracker data and surface what changed week-over-week.',
      expertise: 'As a sleep coach, build and maintain a sleep-hygiene plan with the user; read tracker data weekly and surface what changed.',
    }
    const parsed = LeafSchema.parse(raw)
    expect(parsed.id).toBe('sleep-coach')
    expect(parsed.path).toBe('Expert')
    expect(parsed.parameter).toBeNull()
    expect(parsed.liability).toBeNull()
    expect(parsed.combinesWith).toEqual([])
    expect(parsed.suggestedTools).toEqual([])
  })

  test('parses a fully-populated leaf', () => {
    const raw = {
      id: 'tutor',
      path: 'Expert',
      l2: 'Education',
      name: 'Tutor',
      parameter: 'subject',
      liability: null,
      pitch: 'Teaches a subject from where you actually are. Tracks what you have mastered.',
      expertise: 'As a tutor, teach from where the learner is. Diagnose gaps before reteaching.',
      combinesWith: ['test-prep-coach', 'writing-coach', 'education-milestone'],
      suggestedTools: ['gmail'],
    }
    const parsed = LeafSchema.parse(raw)
    expect(parsed.parameter).toBe('subject')
    expect(parsed.combinesWith).toHaveLength(3)
  })

  test('rejects unknown path', () => {
    expect(() =>
      LeafSchema.parse({ id: 'x', path: 'Other', l2: 'X', name: 'X', pitch: 'X', expertise: 'X' })
    ).toThrow()
  })

  test('rejects unknown liability flag', () => {
    expect(() =>
      LeafSchema.parse({ id: 'x', path: 'Expert', l2: 'X', name: 'X', pitch: 'X', expertise: 'X', liability: 'fishery' })
    ).toThrow()
  })
})

describe('Leaves loader', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'leaves-test-'))
    setLeavesDir(tmpDir)
  })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  function writeLeaf(yaml: string, name: string) {
    writeFileSync(join(tmpDir, `${name}.yaml`), yaml)
  }

  test('loads multiple leaves', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\n`, 'a')
    writeLeaf(`id: b\npath: Service\nl2: Service\nname: B\npitch: b\nexpertise: b\n`, 'b')
    const all = loadAllLeaves()
    expect(all).toHaveLength(2)
  })

  test('findLeaf returns by id', () => {
    writeLeaf(`id: tutor\npath: Expert\nl2: Education\nname: Tutor\nparameter: subject\npitch: t\nexpertise: t\n`, 'tutor')
    const found = findLeaf('tutor')
    expect(found?.name).toBe('Tutor')
    expect(findLeaf('missing')).toBeNull()
  })

  test('symmetric closure adds reverse edges', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\ncombinesWith: [b]\n`, 'a')
    writeLeaf(`id: b\npath: Expert\nl2: X\nname: B\npitch: b\nexpertise: b\n`, 'b')
    const sym = symmetricCombines()
    expect(sym.get('a')).toEqual(new Set(['b']))
    expect(sym.get('b')).toEqual(new Set(['a']))
  })

  test('leavesByPath groups correctly', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\n`, 'a')
    writeLeaf(`id: b\npath: Service\nl2: Service\nname: B\npitch: b\nexpertise: b\n`, 'b')
    const groups = leavesByPath()
    expect(groups.Expert).toHaveLength(1)
    expect(groups.Service).toHaveLength(1)
    expect(groups.Goal).toHaveLength(0)
  })

  test('rejects duplicate id', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: a\nexpertise: a\n`, 'a')
    writeLeaf(`id: a\npath: Service\nl2: Service\nname: A2\npitch: x\nexpertise: x\n`, 'a2')
    expect(() => loadAllLeaves()).toThrow(/duplicate leaf id/)
  })

  test('loadAllLeaves error includes filename for malformed YAML', () => {
    writeLeaf(`id: ok\npath: Expert\nl2: X\nname: Ok\npitch: p\nexpertise: e\n`, 'ok')
    writeLeaf(`id: bad\npath: NotAPath\nl2: X\nname: Bad\npitch: p\nexpertise: e\n`, 'bad')
    expect(() => loadAllLeaves()).toThrow(/leaves\/bad\.yaml/)
  })

  test('loadAllLeaves throws when combinesWith references unknown leaf', () => {
    writeLeaf(`id: a\npath: Expert\nl2: X\nname: A\npitch: p\nexpertise: e\ncombinesWith: [zzz-unknown]\n`, 'a')
    expect(() => loadAllLeaves()).toThrow(/combinesWith.*zzz-unknown/)
  })

  test('duplicate-id error names both files', () => {
    writeLeaf(`id: dup\npath: Expert\nl2: X\nname: A\npitch: p\nexpertise: e\n`, 'first')
    writeLeaf(`id: dup\npath: Service\nl2: Service\nname: B\npitch: p\nexpertise: e\n`, 'second')
    // readdirSync order is filesystem-dependent; assert both filenames appear
    // somewhere in the message, not a particular order.
    expect(() => loadAllLeaves()).toThrow(/first\.yaml/)
    expect(() => loadAllLeaves()).toThrow(/second\.yaml/)
  })

  test('symmetricCombines returns empty Map when leaves dir is missing', () => {
    setLeavesDir('/nonexistent/path/that/does/not/exist')
    expect(loadAllLeaves()).toEqual([])
    const sym = symmetricCombines()
    expect(sym).toBeInstanceOf(Map)
    expect(sym.size).toBe(0)
  })
})
