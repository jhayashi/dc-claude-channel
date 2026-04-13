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
    // claude-code is auto-seeded by listAgents (built-in default agent).
    expect(agents.listAgents().map(a => a.id)).toEqual(['alpha', 'claude-code', 'mike', 'zebra'])
  })

  test('listAgents skips invalid files without throwing', () => {
    agents.saveAgent(makeDef({ id: 'good' }))
    writeFileSync(join(testDir, 'broken.yaml'), '::: garbage')
    // claude-code is auto-seeded by listAgents.
    expect(agents.listAgents().map(a => a.id)).toEqual(['claude-code', 'good'])
  })

  test('listAgents auto-seeds directory and default agent when missing', () => {
    rmSync(testDir, { recursive: true, force: true })
    // listAgents now recreates the dir and seeds the default agent,
    // so the list is never empty.
    expect(agents.listAgents().map(a => a.id)).toEqual(['claude-code'])
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

describe('skipPermissions helpers', () => {
  test('getSkipPermissions defaults to false when metadata is absent', () => {
    expect(agents.getSkipPermissions(makeDef())).toBe(false)
  })

  test('getSkipPermissions defaults to false when metadata exists but key absent', () => {
    const def = makeDef({
      metadata: { 'x-dc-createdAt': '2026-04-10T00:00:00.000Z' },
    })
    expect(agents.getSkipPermissions(def)).toBe(false)
  })

  test('getSkipPermissions returns true when metadata flag is true', () => {
    const def = makeDef({
      metadata: { 'x-dc-skipPermissions': true },
    })
    expect(agents.getSkipPermissions(def)).toBe(true)
  })

  test('setSkipPermissions(true) writes flag into metadata', () => {
    const def = makeDef()
    agents.setSkipPermissions(def, true)
    expect(def.metadata).toBeDefined()
    expect(def.metadata!['x-dc-skipPermissions']).toBe(true)
    expect(agents.getSkipPermissions(def)).toBe(true)
  })

  test('setSkipPermissions(false) removes the flag but preserves other metadata', () => {
    const def = makeDef({
      metadata: {
        'x-dc-skipPermissions': true,
        'x-dc-createdAt': '2026-04-10T00:00:00.000Z',
      },
    })
    agents.setSkipPermissions(def, false)
    expect(def.metadata!['x-dc-skipPermissions']).toBeUndefined()
    expect(def.metadata!['x-dc-createdAt']).toBe('2026-04-10T00:00:00.000Z')
    expect(agents.getSkipPermissions(def)).toBe(false)
  })

  test('round-trips through YAML via saveAgent + getAgent', () => {
    const def = makeDef({ id: 'sp-yaml' })
    agents.setSkipPermissions(def, true)
    agents.saveAgent(def)
    const loaded = agents.getAgent('sp-yaml')
    expect(loaded).not.toBeNull()
    expect(agents.getSkipPermissions(loaded!)).toBe(true)
  })
})

describe('allowedBuiltinTools and allowedMcpServers schema fields', () => {
  test('schema accepts agent with allowedBuiltinTools list', () => {
    const raw = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'claude-sonnet-4-6',
      system: '',
      tools: [],
      allowedBuiltinTools: ['Bash', 'Read', 'Write'],
    }
    const result = agents.AgentDefSchema.safeParse(raw)
    expect(result.success).toBe(true)
    expect(result.data?.allowedBuiltinTools).toEqual(['Bash', 'Read', 'Write'])
  })

  test('schema accepts agent with allowedMcpServers list', () => {
    const raw = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'claude-sonnet-4-6',
      system: '',
      tools: [],
      allowedMcpServers: ['dc', 'claude_ai_Gmail'],
    }
    const result = agents.AgentDefSchema.safeParse(raw)
    expect(result.success).toBe(true)
    expect(result.data?.allowedMcpServers).toEqual(['dc', 'claude_ai_Gmail'])
  })

  test('schema still accepts legacy allowedMcpTools for migration', () => {
    const raw = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'claude-sonnet-4-6',
      system: '',
      tools: [],
      allowedMcpTools: ['dc_send', 'dc_chat_history'],
    }
    const result = agents.AgentDefSchema.safeParse(raw)
    expect(result.success).toBe(true)
    expect(result.data?.allowedMcpTools).toEqual(['dc_send', 'dc_chat_history'])
  })

  test('schema accepts null for allowedBuiltinTools (means all allowed)', () => {
    const raw = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'claude-sonnet-4-6',
      system: '',
      tools: [],
      allowedBuiltinTools: null,
    }
    const result = agents.AgentDefSchema.safeParse(raw)
    expect(result.success).toBe(true)
    expect(result.data?.allowedBuiltinTools).toBeNull()
  })

  test('schema accepts null for allowedMcpServers (means all allowed)', () => {
    const raw = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'claude-sonnet-4-6',
      system: '',
      tools: [],
      allowedMcpServers: null,
    }
    const result = agents.AgentDefSchema.safeParse(raw)
    expect(result.success).toBe(true)
    expect(result.data?.allowedMcpServers).toBeNull()
  })

  test('fields are optional — existing agents without them still load', () => {
    // Write a minimal YAML without the new fields
    writeFileSync(
      join(testDir, 'legacy-agent.yaml'),
      YAML.stringify({
        id: 'legacy-agent',
        name: 'Legacy Agent',
        model: 'claude-sonnet-4-6',
        system: 'you are helpful',
        tools: [],
      }),
    )
    const loaded = agents.getAgent('legacy-agent')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedBuiltinTools).toBeUndefined()
    expect(loaded!.allowedMcpServers).toBeUndefined()
  })

  test('empty arrays mean no tools/servers allowed (distinct from null/absent)', () => {
    const raw = {
      id: 'test-agent',
      name: 'Test Agent',
      model: 'claude-sonnet-4-6',
      system: '',
      tools: [],
      allowedBuiltinTools: [],
      allowedMcpServers: [],
    }
    const result = agents.AgentDefSchema.safeParse(raw)
    expect(result.success).toBe(true)
    expect(result.data?.allowedBuiltinTools).toEqual([])
    expect(result.data?.allowedMcpServers).toEqual([])
  })

  test('round-trips allowedBuiltinTools and allowedMcpServers through YAML', () => {
    const def = makeDef({
      id: 'tool-restricted',
      allowedBuiltinTools: ['Read', 'Glob'],
      allowedMcpServers: ['dc', 'claude_ai_Gmail'],
    })
    agents.saveAgent(def)
    const loaded = agents.getAgent('tool-restricted')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedBuiltinTools).toEqual(['Read', 'Glob'])
    expect(loaded!.allowedMcpServers).toEqual(['dc', 'claude_ai_Gmail'])
  })

  test('migrateToolsToServers converts legacy allowedMcpTools on load', () => {
    // Write a YAML file with the old allowedMcpTools field
    writeFileSync(
      join(testDir, 'legacy-mcp.yaml'),
      YAML.stringify({
        id: 'legacy-mcp',
        name: 'Legacy MCP',
        model: 'claude-sonnet-4-6',
        system: 'test',
        tools: [],
        allowedMcpTools: ['dc_send', 'dc_chat_history'],
      }),
    )
    const loaded = agents.getAgent('legacy-mcp')
    expect(loaded).not.toBeNull()
    // Should have been migrated to allowedMcpServers
    expect(loaded!.allowedMcpServers).toEqual(['dc'])
    expect(loaded!.allowedMcpTools).toBeUndefined()
  })

  test('migrateToolsToServers converts empty allowedMcpTools to empty servers', () => {
    writeFileSync(
      join(testDir, 'legacy-empty.yaml'),
      YAML.stringify({
        id: 'legacy-empty',
        name: 'Legacy Empty',
        model: 'claude-sonnet-4-6',
        system: 'test',
        tools: [],
        allowedMcpTools: [],
      }),
    )
    const loaded = agents.getAgent('legacy-empty')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedMcpServers).toEqual([])
    expect(loaded!.allowedMcpTools).toBeUndefined()
  })

  test('migrateToolsToServers does not touch agents with allowedMcpServers already set', () => {
    const def = makeDef({
      id: 'already-migrated',
      allowedMcpServers: ['dc', 'claude_ai_Gmail'],
    })
    agents.saveAgent(def)
    const loaded = agents.getAgent('already-migrated')
    expect(loaded).not.toBeNull()
    expect(loaded!.allowedMcpServers).toEqual(['dc', 'claude_ai_Gmail'])
  })

  test('getAgentsDir returns the current agents directory', () => {
    const dir = agents.getAgentsDir()
    expect(typeof dir).toBe('string')
    expect(dir.length).toBeGreaterThan(0)
  })
})

describe('iconMirror helpers', () => {
  test('getIconMirror defaults to false when metadata absent', () => {
    expect(agents.getIconMirror(makeDef())).toBe(false)
  })

  test('setIconMirror(true) writes flag and getter reads it', () => {
    const def = makeDef()
    agents.setIconMirror(def, true)
    expect(def.metadata!['x-dc-iconMirror']).toBe(true)
    expect(agents.getIconMirror(def)).toBe(true)
  })

  test('setIconMirror(false) removes flag but preserves sibling metadata', () => {
    const def = makeDef({
      metadata: {
        'x-dc-iconMirror': true,
        'x-dc-skipPermissions': true,
      },
    })
    agents.setIconMirror(def, false)
    expect(def.metadata!['x-dc-iconMirror']).toBeUndefined()
    expect(def.metadata!['x-dc-skipPermissions']).toBe(true)
  })

  test('round-trips through YAML', () => {
    const def = makeDef({ id: 'mirror-yaml' })
    agents.setIconMirror(def, true)
    agents.saveAgent(def)
    const loaded = agents.getAgent('mirror-yaml')
    expect(agents.getIconMirror(loaded!)).toBe(true)
  })
})

describe('default agent (undeletable)', () => {
  test('isUndeletableAgent recognises the sentinel and nothing else', () => {
    expect(agents.isUndeletableAgent(agents.DEFAULT_AGENT_ID)).toBe(true)
    expect(agents.isUndeletableAgent('claude-code')).toBe(true)
    expect(agents.isUndeletableAgent('claude-code-2')).toBe(false)
    expect(agents.isUndeletableAgent('anything-else')).toBe(false)
  })

  test('ensureDefaultAgent seeds the default agent on an empty dir', () => {
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).toBeNull()
    const seeded = agents.ensureDefaultAgent()
    expect(seeded.id).toBe(agents.DEFAULT_AGENT_ID)
    expect(seeded.name).toBe('Claude Code')
    expect(seeded.model).toBe(agents.DEFAULT_MODEL)
    expect(seeded.system).toBe(agents.DEFAULT_SYSTEM_PROMPT)
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).not.toBeNull()
  })

  test('ensureDefaultAgent preserves user edits on subsequent calls', () => {
    agents.ensureDefaultAgent()
    const custom = agents.getAgent(agents.DEFAULT_AGENT_ID)!
    custom.name = 'My Custom Default'
    custom.system = 'you are my personal assistant'
    custom.model = 'claude-opus-4-6'
    agents.saveAgent(custom)

    const after = agents.ensureDefaultAgent()
    expect(after.name).toBe('My Custom Default')
    expect(after.system).toBe('you are my personal assistant')
    expect(after.model).toBe('claude-opus-4-6')
  })

  test('listAgents auto-seeds the default when no files exist', () => {
    const list = agents.listAgents()
    expect(list.length).toBe(1)
    expect(list[0]!.id).toBe(agents.DEFAULT_AGENT_ID)
  })

  test('listAgents includes both default and user-created agents', () => {
    agents.saveAgent(makeDef({ id: 'user-agent', name: 'User Agent' }))
    const list = agents.listAgents()
    const ids = list.map(a => a.id)
    expect(ids).toContain(agents.DEFAULT_AGENT_ID)
    expect(ids).toContain('user-agent')
  })

  test('deleteAgent refuses the sentinel id', () => {
    agents.ensureDefaultAgent()
    expect(() => agents.deleteAgent(agents.DEFAULT_AGENT_ID)).toThrow(
      /cannot delete built-in default agent/,
    )
    expect(agents.getAgent(agents.DEFAULT_AGENT_ID)).not.toBeNull()
  })

  test('deleteAgent still works on a non-sentinel agent', () => {
    agents.saveAgent(makeDef({ id: 'throwaway' }))
    expect(agents.deleteAgent('throwaway')).toBe(true)
    expect(agents.getAgent('throwaway')).toBeNull()
  })

  test('name / model / prompt edits on the sentinel persist', () => {
    agents.ensureDefaultAgent()
    expect(agents.updateAgentPrompt(agents.DEFAULT_AGENT_ID, 'new system')).toBe(true)
    expect(agents.updateAgentModel(agents.DEFAULT_AGENT_ID, 'claude-haiku-4-5')).toBe(true)

    const def = agents.getAgent(agents.DEFAULT_AGENT_ID)!
    def.name = 'Renamed Default'
    agents.saveAgent(def)

    const reloaded = agents.getAgent(agents.DEFAULT_AGENT_ID)!
    expect(reloaded.name).toBe('Renamed Default')
    expect(reloaded.model).toBe('claude-haiku-4-5')
    expect(reloaded.system).toBe('new system')
  })
})

describe('importAgentFromYaml', () => {
  test('imports a valid YAML string and saves the agent', () => {
    const yaml = [
      'id: imported-agent',
      'name: Imported Agent',
      'model: claude-sonnet-4-6',
      'system: you are helpful',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('imported-agent')
    expect(result.agent.name).toBe('Imported Agent')
    expect(result.idChanged).toBe(false)
    expect(agents.getAgent('imported-agent')).toBeTruthy()
  })

  test('synthesizes id from name when id is missing', () => {
    const yaml = [
      'name: My Cool Agent',
      'model: claude-sonnet-4-6',
      'system: be cool',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('my-cool-agent')
    expect(result.idChanged).toBe(false)
    expect(agents.getAgent('my-cool-agent')).toBeTruthy()
  })

  test('auto-suffixes when id collides with existing agent', () => {
    agents.saveAgent(makeDef({ id: 'collider', name: 'Collider' }))
    const yaml = [
      'id: collider',
      'name: Collider Clone',
      'model: claude-sonnet-4-6',
      'system: clone',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('collider-2')
    expect(result.idChanged).toBe(true)
    expect(agents.getAgent('collider-2')).toBeTruthy()
  })

  test('auto-suffixes when synthesized id collides', () => {
    agents.saveAgent(makeDef({ id: 'dupe-name', name: 'Dupe Name' }))
    const yaml = [
      'name: Dupe Name',
      'model: claude-sonnet-4-6',
      'system: dupe',
      'tools: []',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.id).toBe('dupe-name-2')
    expect(result.idChanged).toBe(true)
  })

  test('preserves metadata including x-dc-* extensions', () => {
    const yaml = [
      'id: meta-agent',
      'name: Meta Agent',
      'model: claude-sonnet-4-6',
      'system: meta',
      'tools: []',
      'metadata:',
      '  x-dc-skipPermissions: true',
      '  x-dc-iconMirror: true',
      '  custom-key: custom-value',
    ].join('\n')
    const result = agents.importAgentFromYaml(yaml)
    expect(result.agent.metadata).toEqual({
      'x-dc-skipPermissions': true,
      'x-dc-iconMirror': true,
      'custom-key': 'custom-value',
    })
  })

  test('throws on invalid YAML', () => {
    expect(() => agents.importAgentFromYaml('{not: [valid yaml')).toThrow()
  })

  test('throws on valid YAML that fails schema validation', () => {
    const yaml = [
      'id: bad-model',
      'name: Bad Model',
      'model: gpt-4',
      'system: nope',
      'tools: []',
    ].join('\n')
    expect(() => agents.importAgentFromYaml(yaml)).toThrow()
  })

  test('throws when name is missing', () => {
    const yaml = [
      'id: no-name',
      'model: claude-sonnet-4-6',
      'system: nope',
      'tools: []',
    ].join('\n')
    expect(() => agents.importAgentFromYaml(yaml)).toThrow()
  })

  test('round-trip: export then import produces identical agent', () => {
    const original = makeDef({
      id: 'roundtrip-export',
      name: 'Roundtrip Export',
      description: 'A test agent for round-trip',
      system: 'be helpful and precise',
      metadata: { 'x-dc-skipPermissions': true, 'custom': 'value' },
    })
    agents.saveAgent(original)

    // Export: read the saved YAML (simulates what the export handler does).
    const exported = agents.getAgent('roundtrip-export')!
    const yamlStr = YAML.stringify(exported)

    // Delete the original so the import doesn't collide.
    agents.deleteAgent('roundtrip-export')

    // Import the exported YAML.
    const result = agents.importAgentFromYaml(yamlStr)
    expect(result.idChanged).toBe(false)
    expect(result.agent).toEqual(original)
  })

  test('round-trip with collision: import gets suffixed id', () => {
    const original = makeDef({
      id: 'rt-collide',
      name: 'RT Collide',
      system: 'original',
    })
    agents.saveAgent(original)

    const yamlStr = YAML.stringify(original)

    // Import without deleting — should get -2 suffix.
    const result = agents.importAgentFromYaml(yamlStr)
    expect(result.idChanged).toBe(true)
    expect(result.agent.id).toBe('rt-collide-2')
    expect(result.agent.name).toBe('RT Collide')
  })
})
