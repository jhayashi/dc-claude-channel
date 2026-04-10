import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import YAML from 'yaml'
import * as agents from '../agents'

const testDir = mkdtempSync(join(tmpdir(), 'dc-agents-test-'))

beforeAll(() => agents.setAgentsDir(testDir))
beforeEach(() => {
  // Clean the test dir between tests so collision/listing tests don't
  // see stale files from earlier runs.
  if (existsSync(testDir)) {
    for (const f of readdirSync(testDir)) {
      unlinkSync(join(testDir, f))
    }
  }
})
afterAll(() => rmSync(testDir, { recursive: true, force: true }))

function makeDef(overrides: Partial<agents.AgentDef> = {}): agents.AgentDef {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    model: 'claude-sonnet-4-6',
    description: '',
    system: 'you are helpful',
    tools: [],
    ...overrides,
  }
}

describe('agents registry', () => {
  test('round-trips a full agent definition through YAML', () => {
    const def = makeDef({ id: 'round-trip', name: 'Round Trip' })
    agents.saveAgent(def)
    expect(agents.getAgent('round-trip')).toEqual(def)
  })

  test('saved file is readable as YAML and preserves keys', () => {
    const def = makeDef({
      id: 'disk-agent',
      name: 'Disk Agent',
      model: 'claude-haiku-4-5',
      system: 'be quick',
    })
    agents.saveAgent(def)
    const contents = readFileSync(join(testDir, 'disk-agent.yaml'), 'utf-8')
    const parsed = YAML.parse(contents)
    expect(parsed).toEqual(def)
    // Sanity: it's actually YAML, not JSON
    expect(contents).toContain('id: disk-agent')
    expect(contents).toContain('model: claude-haiku-4-5')
  })

  test('getAgent returns null for missing id', () => {
    expect(agents.getAgent('nonexistent')).toBeNull()
  })

  test('getAgent returns null for unparseable YAML', () => {
    writeFileSync(join(testDir, 'broken.yaml'), '::: not: [valid yaml')
    expect(agents.getAgent('broken')).toBeNull()
  })

  test('getAgent returns null for schema-invalid YAML', () => {
    writeFileSync(
      join(testDir, 'bad.yaml'),
      YAML.stringify({ id: 'bad', name: 'Bad' }),
    )
    expect(agents.getAgent('bad')).toBeNull()
  })

  test('rejects invalid schema on save', () => {
    expect(() =>
      agents.saveAgent({ id: 'invalid' } as unknown as agents.AgentDef),
    ).toThrow()
  })

  test('rejects id that is not a lowercase slug', () => {
    expect(() =>
      agents.saveAgent(makeDef({ id: 'Has Capitals' })),
    ).toThrow()
  })

  test('listAgents returns all agents sorted by id', () => {
    agents.saveAgent(makeDef({ id: 'zebra' }))
    agents.saveAgent(makeDef({ id: 'alpha' }))
    agents.saveAgent(makeDef({ id: 'mike' }))
    expect(agents.listAgents().map(a => a.id)).toEqual(['alpha', 'mike', 'zebra'])
  })

  test('listAgents skips invalid files without throwing', () => {
    agents.saveAgent(makeDef({ id: 'good' }))
    writeFileSync(join(testDir, 'broken.yaml'), '::: garbage')
    expect(agents.listAgents().map(a => a.id)).toEqual(['good'])
  })

  test('listAgents returns empty array when directory missing', () => {
    rmSync(testDir, { recursive: true, force: true })
    expect(agents.listAgents()).toEqual([])
  })

  test('deleteAgent removes the file', () => {
    agents.saveAgent(makeDef({ id: 'goner' }))
    expect(agents.getAgent('goner')).not.toBeNull()
    expect(agents.deleteAgent('goner')).toBe(true)
    expect(agents.getAgent('goner')).toBeNull()
    expect(agents.deleteAgent('goner')).toBe(false)
  })

  test('updateAgentPrompt edits system in place', () => {
    agents.saveAgent(makeDef({ id: 'editable' }))
    expect(agents.updateAgentPrompt('editable', 'new system')).toBe(true)
    expect(agents.getAgent('editable')!.system).toBe('new system')
  })

  test('updateAgentPrompt returns false for missing agent', () => {
    expect(agents.updateAgentPrompt('nonesuch', 'x')).toBe(false)
  })

  test('updateAgentModel edits model in place', () => {
    agents.saveAgent(makeDef({ id: 'swappable' }))
    expect(agents.updateAgentModel('swappable', 'claude-opus-4-6')).toBe(true)
    expect(agents.getAgent('swappable')!.model).toBe('claude-opus-4-6')
  })

  test('updateAgentModel throws on invalid model', () => {
    agents.saveAgent(makeDef({ id: 'swappable' }))
    expect(() =>
      agents.updateAgentModel('swappable', 'not-a-model' as agents.AllowedModel),
    ).toThrow()
  })

  test('updateAgentModel returns false for missing agent', () => {
    expect(agents.updateAgentModel('nothing', 'claude-sonnet-4-6')).toBe(false)
  })
})

describe('synthesizeAgentId', () => {
  test('slugifies a plain name', () => {
    expect(agents.synthesizeAgentId('Marketing Agent')).toBe('marketing-agent')
  })

  test('collapses punctuation and whitespace', () => {
    expect(agents.synthesizeAgentId('Hello,   World! Agent')).toBe('hello-world-agent')
  })

  test('strips leading and trailing hyphens', () => {
    expect(agents.synthesizeAgentId('--Weird--Name--')).toBe('weird-name')
  })

  test('falls back to "agent" on empty slug', () => {
    expect(agents.synthesizeAgentId('!!!')).toBe('agent')
    expect(agents.synthesizeAgentId('')).toBe('agent')
  })

  test('adds collision suffix when id exists', () => {
    agents.saveAgent(makeDef({ id: 'marketing-agent' }))
    expect(agents.synthesizeAgentId('Marketing Agent')).toBe('marketing-agent-2')
  })

  test('continues collision suffix on further conflicts', () => {
    agents.saveAgent(makeDef({ id: 'marketing-agent' }))
    agents.saveAgent(makeDef({ id: 'marketing-agent-2' }))
    expect(agents.synthesizeAgentId('Marketing Agent')).toBe('marketing-agent-3')
  })
})

describe('draftAgentFromDescription', () => {
  test('defaults to sonnet when no model specified', () => {
    const { agent } = agents.draftAgentFromDescription('marketing help')
    expect(agent.model).toBe('claude-sonnet-4-6')
  })

  test('uses caller-specified model', () => {
    expect(
      agents.draftAgentFromDescription('debug a python bug', 'claude-opus-4-6').agent.model,
    ).toBe('claude-opus-4-6')
    expect(
      agents.draftAgentFromDescription('quick questions', 'claude-haiku-4-5').agent.model,
    ).toBe('claude-haiku-4-5')
  })

  test('assigns matching system prompt for model', () => {
    const opus = agents.draftAgentFromDescription('coding', 'claude-opus-4-6')
    expect(opus.agent.system).toContain('software engineering')

    const haiku = agents.draftAgentFromDescription('quick QA', 'claude-haiku-4-5')
    expect(haiku.agent.system).toContain('concise')

    const sonnet = agents.draftAgentFromDescription('chat about books')
    expect(sonnet.agent.system).toBe(agents.DEFAULT_SYSTEM_PROMPT)
  })

  test('returns inheritClaudeMd based on model', () => {
    expect(agents.draftAgentFromDescription('code', 'claude-opus-4-6').inheritClaudeMd).toBe(true)
    expect(agents.draftAgentFromDescription('qa', 'claude-haiku-4-5').inheritClaudeMd).toBe(false)
    expect(agents.draftAgentFromDescription('general chat').inheritClaudeMd).toBe(true)
  })

  test('extracts purpose-based name from preamble phrases', () => {
    expect(agents.draftAgentFromDescription('I want a marketing agent').agent.name).toBe(
      'Marketing Agent',
    )
    expect(agents.draftAgentFromDescription('social media').agent.name).toBe(
      'Social Media Agent',
    )
    expect(agents.draftAgentFromDescription('create a sales assistant').agent.name).toBe(
      'Sales Assistant',
    )
  })

  test('draft is a valid input to saveAgent once id is added', () => {
    const { agent } = agents.draftAgentFromDescription('marketing help')
    agents.saveAgent({ ...agent, id: 'marketing-help' })
    const loaded = agents.getAgent('marketing-help')
    expect(loaded).not.toBeNull()
    expect(loaded!.name).toBe(agent.name)
    expect(loaded!.system).toBe(agent.system)
  })
})
