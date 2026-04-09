import { describe, test, expect } from 'bun:test'
import { buildSubagentArgs, type SubagentSpawnOptions } from '../dispatcher/subagent-process'

function baseOpts(extra: Partial<SubagentSpawnOptions> = {}): SubagentSpawnOptions {
  return {
    chatId: 7,
    subagentId: 'sub-7-abcd',
    settingsPath: '/tmp/settings.json',
    dispatcherSocket: '/tmp/sock',
    dispatcherSecret: 'secret',
    sessionId: 'session-1',
    resume: false,
    ...extra,
  }
}

describe('buildSubagentArgs', () => {
  test('default args contain core flags and no --model', () => {
    const { args, envBlock } = buildSubagentArgs(baseOpts())
    expect(args).toContain('-p')
    expect(args).toContain('--session-id')
    expect(args).toContain('session-1')
    expect(args).not.toContain('--resume')
    expect(args).toContain('--settings')
    expect(args).toContain('/tmp/settings.json')
    expect(args).not.toContain('--setting-sources') // user-level settings inherited
    expect(args).toContain('--permission-mode')
    expect(args).toContain('default')
    expect(args).toContain('--append-system-prompt')
    expect(args).not.toContain('--model')
    expect(envBlock).toContain('Bound chat: 7')
    expect(envBlock).not.toContain('\n\n') // no extra system prompt
  })

  test('resume=true uses --resume instead of --session-id', () => {
    const { args } = buildSubagentArgs(baseOpts({ sessionId: 'abc-123', resume: true }))
    expect(args).toContain('--resume')
    const i = args.indexOf('--resume')
    expect(args[i + 1]).toBe('abc-123')
    expect(args).not.toContain('--session-id')
  })

  test('--model is added when model option is set', () => {
    const { args } = buildSubagentArgs(baseOpts({ model: 'claude-opus-4-6' }))
    const i = args.indexOf('--model')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(args[i + 1]).toBe('claude-opus-4-6')
  })

  test('systemPrompt is appended to the env block', () => {
    const { args, envBlock } = buildSubagentArgs(
      baseOpts({ systemPrompt: 'You are a coding assistant.' }),
    )
    expect(envBlock).toContain('Bound chat: 7')
    expect(envBlock).toContain('You are a coding assistant.')
    const i = args.indexOf('--append-system-prompt')
    expect(args[i + 1]).toBe(envBlock)
  })

  test('mcpConfigPath adds --mcp-config and --allowedTools (no --strict-mcp-config)', () => {
    const { args } = buildSubagentArgs(baseOpts({ mcpConfigPath: '/tmp/mcp.json' }))
    expect(args).toContain('--mcp-config')
    expect(args).toContain('/tmp/mcp.json')
    // User's global MCP servers merge in; we do NOT use --strict-mcp-config.
    expect(args).not.toContain('--strict-mcp-config')
    expect(args).toContain('--allowedTools')
    const i = args.indexOf('--allowedTools')
    const list = args[i + 1]
    expect(list).toContain('mcp__dc')
    expect(list).toContain('Skill')
    expect(list).toContain('ToolSearch')
    expect(list).toContain('WebSearch')
    expect(list).toContain('LSP')
    expect(list).not.toContain('CronCreate')
    expect(list).not.toContain('RemoteTrigger')
  })

  test('addDirs are passed as --add-dir', () => {
    const { args } = buildSubagentArgs(baseOpts({ addDirs: ['/foo', '/bar'] }))
    const dirs = args.reduce<string[]>((acc, v, i) => {
      if (args[i - 1] === '--add-dir') acc.push(v)
      return acc
    }, [])
    expect(dirs).toEqual(['/foo', '/bar'])
  })

  test('suppressUserClaudeMd is accepted (currently a no-op, no flag emitted)', () => {
    const { args } = buildSubagentArgs(baseOpts({ suppressUserClaudeMd: true }))
    expect(args).not.toContain('--no-user-claude-md')
    expect(args).not.toContain('CLAUDE_DISABLE_USER_CLAUDE_MD')
  })
})
