import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as templates from '../templates'

const testDir = mkdtempSync(join(tmpdir(), 'dc-templates-test-'))

beforeAll(() => templates.setTemplatesDir(testDir))
beforeEach(() => {
  if (existsSync(testDir)) {
    for (const f of readdirSync(testDir)) unlinkSync(join(testDir, f))
  }
})
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

function writeTemplate(filename: string, body: string): void {
  writeFileSync(join(testDir, filename), body)
}

const validTemplate = `id: test-role
name: Test Role
model: claude-sonnet-4-6
system: hi
tools: []
metadata:
  x-dc-archetype: role
  x-dc-icon: 🐈
  x-dc-template:
    category: role
    description: A test role
    requires:
      mcpServers:
        - claude_ai_Gmail
`

describe('listTemplates', () => {
  test('returns empty when directory is empty', () => {
    expect(templates.listTemplates()).toEqual([])
  })

  test('returns empty when directory does not exist', () => {
    const savedDir = templates.getTemplatesDir()
    templates.setTemplatesDir(join(tmpdir(), 'no-such-dir-' + Math.random()))
    try {
      expect(templates.listTemplates()).toEqual([])
    } finally {
      templates.setTemplatesDir(savedDir)
    }
  })

  test('loads a valid template and surfaces all fields', () => {
    writeTemplate('test-role.yaml', validTemplate)
    const list = templates.listTemplates()
    expect(list.length).toBe(1)
    const t = list[0]
    expect(t.id).toBe('test-role')
    expect(t.name).toBe('Test Role')
    expect(t.archetype).toBe('role')
    expect(t.icon).toBe('🐈')
    expect(t.model).toBe('claude-sonnet-4-6')
    expect(t.description).toBe('A test role')
    expect(t.requires.mcpServers).toEqual(['claude_ai_Gmail'])
  })

  test('skips files that fail schema validation', () => {
    writeTemplate('bad.yaml', 'id: bad\nname: Bad\n')  // missing model etc
    writeTemplate('good.yaml', validTemplate)
    const list = templates.listTemplates()
    expect(list.map(t => t.id)).toEqual(['test-role'])
  })

  test('skips files without x-dc-template metadata', () => {
    writeTemplate(
      'no-template-meta.yaml',
      `id: no-meta
name: No Meta
model: claude-sonnet-4-6
system: hi
tools: []
`,
    )
    expect(templates.listTemplates()).toEqual([])
  })

  test('falls back to archetype default icon when x-dc-icon unset', () => {
    writeTemplate(
      'no-icon.yaml',
      `id: no-icon
name: No Icon
model: claude-sonnet-4-6
system: hi
tools: []
metadata:
  x-dc-template:
    category: utility
    description: no icon
    requires:
      mcpServers: []
`,
    )
    const list = templates.listTemplates()
    expect(list.length).toBe(1)
    expect(list[0].archetype).toBe('utility')
    expect(list[0].icon).toBe('⚙️')
  })

  test('sorts by id alphabetically', () => {
    writeTemplate('z.yaml', validTemplate.replace('test-role', 'z-agent'))
    writeTemplate('a.yaml', validTemplate.replace('test-role', 'a-agent'))
    const list = templates.listTemplates()
    expect(list.map(t => t.id)).toEqual(['a-agent', 'z-agent'])
  })

  test('skips unparseable YAML', () => {
    writeTemplate('broken.yaml', ': : :\ngarbage')
    writeTemplate('good.yaml', validTemplate)
    expect(templates.listTemplates().length).toBe(1)
  })
})

describe('instantiate', () => {
  test('returns a DraftAgent with template metadata stripped', () => {
    writeTemplate('test-role.yaml', validTemplate)
    const draft = templates.instantiate('test-role')
    expect(draft).not.toBeNull()
    expect(draft!.name).toBe('Test Role')
    expect(draft!.model).toBe('claude-sonnet-4-6')
    expect(draft!.metadata?.['x-dc-template']).toBeUndefined()
  })

  test('preserves x-dc-archetype and x-dc-icon on the draft', () => {
    writeTemplate('test-role.yaml', validTemplate)
    const draft = templates.instantiate('test-role')
    expect(draft!.metadata?.['x-dc-archetype']).toBe('role')
    expect(draft!.metadata?.['x-dc-icon']).toBe('🐈')
  })

  test('returns null for an unknown template id', () => {
    writeTemplate('test-role.yaml', validTemplate)
    expect(templates.instantiate('bogus')).toBeNull()
  })

  test('metadata becomes undefined when template metadata was the only key', () => {
    writeTemplate(
      'only-template.yaml',
      `id: only-template
name: Only Template
model: claude-sonnet-4-6
system: hi
tools: []
metadata:
  x-dc-template:
    category: role
    description: only template meta
    requires:
      mcpServers: []
`,
    )
    const draft = templates.instantiate('only-template')
    expect(draft).not.toBeNull()
    expect(draft!.metadata).toBeUndefined()
  })
})

describe('shipped templates', () => {
  // Verify the 12 actual ship templates parse — use the default dir.
  test('all 12 ship templates load', () => {
    templates.setTemplatesDir(join(import.meta.dir, '..', 'templates'))
    try {
      const list = templates.listTemplates()
      expect(list.length).toBe(12)
      const expected = [
        'coach', 'developer', 'email-digest', 'event-planner',
        'exec-assistant', 'homework-helper', 'marketer', 'news-briefing',
        'pm', 'scheduler', 'trip-planner', 'tutor',
      ]
      expect(list.map(t => t.id).sort()).toEqual(expected.sort())
    } finally {
      templates.setTemplatesDir(testDir)
    }
  })

  test('ship template categories match the 6/3/3 split', () => {
    templates.setTemplatesDir(join(import.meta.dir, '..', 'templates'))
    try {
      const list = templates.listTemplates()
      const roles = list.filter(t => t.archetype === 'role').length
      const utilities = list.filter(t => t.archetype === 'utility').length
      const projects = list.filter(t => t.archetype === 'project').length
      expect(roles).toBe(6)
      expect(utilities).toBe(3)
      expect(projects).toBe(3)
    } finally {
      templates.setTemplatesDir(testDir)
    }
  })
})
