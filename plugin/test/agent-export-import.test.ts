import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as agents from '../agents.js'
import { tryImportAgentAttachment, type AgentImportDeps } from '../dispatcher/agent-import.js'

// #130: the export→import round trip was broken since the v1.4 migration —
// export wrote bare YAML.stringify(agent) (no --- frontmatter) while import
// required frontmatter-markdown; and real terminal-CC .md files were never
// intercepted at all (.yaml/.yml extensions only).

const CHAT = 9

function makeDeps() {
  const sent: string[] = []
  const deps: AgentImportDeps = {
    send: async (_chatId: number, text: string) => { sent.push(text) },
    logf: () => {},
  }
  return { deps, sent }
}

function fileMsg(dir: string, fileName: string, content: string) {
  const path = join(dir, fileName)
  writeFileSync(path, content)
  return { chatId: CHAT, file: path, fileName, fileBytes: Buffer.byteLength(content) }
}

describe('agent export → import round trip (#130)', () => {
  let agentsDir: string
  let filesDir: string

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), 'exp-agents-'))
    filesDir = mkdtempSync(join(tmpdir(), 'exp-files-'))
    agents.setAgentsDir(agentsDir)
  })

  afterEach(() => {
    for (const d of [agentsDir, filesDir]) {
      try { rmSync(d, { recursive: true, force: true }) } catch {}
    }
  })

  function seedAgent(name: string): agents.AgentDef {
    agents.saveAgent({
      name,
      description: 'test exportee',
      model: 'claude-sonnet-5',
      body: 'You are a test agent.\n\nBe brief.',
      'x-dc-display-name': 'Test Exportee',
    } as agents.AgentDef)
    return agents.getAgent(name)!
  }

  test('exportAgentMarkdown output starts with --- frontmatter', () => {
    const agent = seedAgent('exportee')
    const text = agents.exportAgentMarkdown(agent)
    expect(text.startsWith('---\n')).toBe(true)
    expect(text).toContain('name: exportee')
    expect(text).toContain('You are a test agent.')
  })

  test('round trip: exported text re-imports with fields intact', () => {
    const agent = seedAgent('exportee')
    const text = agents.exportAgentMarkdown(agent)
    // Simulate importing on another install: remove the original first.
    agents.deleteAgent('exportee')
    const result = agents.importAgentFromMarkdown(text)
    expect(result.nameChanged).toBe(false)
    expect(result.agent.name).toBe('exportee')
    expect(result.agent.model).toBe(agent.model)
    expect(result.agent.body).toBe(agent.body)
    expect(result.agent['x-dc-display-name']).toBe('Test Exportee')
  })

  test('.md attachment with agent frontmatter imports (the documented terminal-CC flow)', async () => {
    const { deps, sent } = makeDeps()
    const msg = fileMsg(filesDir, 'helper.md', '---\nname: helper\ndescription: a helper\nmodel: claude-sonnet-5\n---\n\nYou help.\n')
    const handled = await tryImportAgentAttachment(deps, msg)
    expect(handled).toBe(true)
    expect(agents.getAgent('helper')).not.toBeNull()
    expect(sent.some(t => t.includes('Imported agent'))).toBe(true)
  })

  test('.yaml attachment still imports (legacy path)', async () => {
    const { deps } = makeDeps()
    const msg = fileMsg(filesDir, 'helper2.yaml', '---\nname: helper2\nmodel: claude-sonnet-5\n---\n\nYou help too.\n')
    const handled = await tryImportAgentAttachment(deps, msg)
    expect(handled).toBe(true)
    expect(agents.getAgent('helper2')).not.toBeNull()
  })

  test('ordinary .md without frontmatter passes through silently', async () => {
    const { deps, sent } = makeDeps()
    const msg = fileMsg(filesDir, 'notes.md', '# Meeting notes\n\n- talked about stuff\n')
    const handled = await tryImportAgentAttachment(deps, msg)
    expect(handled).toBe(false)
    expect(sent.length).toBe(0) // no error toast — it's just a document
  })

  test('.md with non-agent frontmatter (e.g. Jekyll) passes through silently', async () => {
    const { deps, sent } = makeDeps()
    const msg = fileMsg(filesDir, 'post.md', '---\ntitle: My Post\ndate: 2026-07-09\n---\n\nHello world.\n')
    const handled = await tryImportAgentAttachment(deps, msg)
    expect(handled).toBe(false)
    expect(sent.length).toBe(0)
  })

  test('agent-shaped .md that fails validation surfaces an error and falls through', async () => {
    const { deps, sent } = makeDeps()
    // name present (agent-shaped) but model is invalid shape → Zod error
    const msg = fileMsg(filesDir, 'broken.md', '---\nname: broken\nmodel: 42\n---\n\nbody\n')
    const handled = await tryImportAgentAttachment(deps, msg)
    expect(handled).toBe(false)
    expect(sent.some(t => t.includes("Couldn't import"))).toBe(true)
  })

  test('success copy does not reference the retired agent setup card', async () => {
    const { deps, sent } = makeDeps()
    const msg = fileMsg(filesDir, 'helper3.md', '---\nname: helper3\nmodel: claude-sonnet-5\n---\n\nYou help.\n')
    await tryImportAgentAttachment(deps, msg)
    const success = sent.find(t => t.includes('Imported agent'))!
    expect(success.toLowerCase()).not.toContain('agent setup card')
  })

  test('oversize file is refused with a message', async () => {
    const { deps, sent } = makeDeps()
    const big = '---\nname: big\nmodel: claude-sonnet-5\n---\n\n' + 'x'.repeat(300 * 1024)
    const msg = fileMsg(filesDir, 'big.md', big)
    const handled = await tryImportAgentAttachment(deps, msg)
    expect(handled).toBe(true)
    expect(sent.some(t => t.includes('too large'))).toBe(true)
  })
})
