import { describe, test, expect } from 'bun:test'
import { buildSubagentArgs, type SubagentSpawnOptions } from '../dispatcher/subagent-process'

function baseOpts(extra: Partial<SubagentSpawnOptions> = {}): SubagentSpawnOptions {
  return {
    chatId: 7,
    subagentId: 'sub-7-abcd',
    agentName: 'test-agent',
    settingsPath: '/tmp/settings.json',
    dispatcherSocket: '/tmp/sock',
    dispatcherSecret: 'secret',
    sessionId: 'session-1',
    resume: false,
    ...extra,
  }
}

describe('buildSubagentArgs', () => {
  test('default args contain --agent <name> and core flags', () => {
    const { args, envBlock } = buildSubagentArgs(baseOpts({ agentName: 'developer' }))
    expect(args).toContain('-p')
    expect(args).toContain('--agent')
    expect(args[args.indexOf('--agent') + 1]).toBe('developer')
    expect(args).toContain('--session-id')
    expect(args).toContain('session-1')
    expect(args).toContain('--input-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--output-format')
    expect(args).toContain('--verbose')
    expect(args).toContain('--settings')
    expect(args).toContain('/tmp/settings.json')
    expect(args).toContain('--append-system-prompt')
    expect(envBlock).toContain('Bound chat: 7')
  })

  test('does NOT pass --model / --effort / --permission-mode / --allowedTools', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agentName: 'developer',
      model: 'claude-opus-4-7',  // ignored — set on the .md
      effort: 'max',              // ignored — set on the .md
    }))
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--allowedTools')
  })

  test('--append-system-prompt contains env block only (no agent system prompt)', () => {
    const { args, envBlock } = buildSubagentArgs(baseOpts({
      agentName: 'developer',
      systemPrompt: 'You are foo.',  // ignored; agent body lives in the .md
    }))
    const idx = args.indexOf('--append-system-prompt')
    expect(args[idx + 1]).toBe(envBlock)
    expect(envBlock).not.toContain('You are foo.')
  })

  test('resume=true uses --resume', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agentName: 'developer', sessionId: 'abc-123', resume: true,
    }))
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123')
    expect(args).not.toContain('--session-id')
  })

  test('--mcp-config is still passed (DC tools-proxy)', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agentName: 'developer', mcpConfigPath: '/tmp/mcp.json',
    }))
    expect(args).toContain('--mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json')
  })

  test('addDirs are passed as --add-dir', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agentName: 'developer', addDirs: ['/foo', '/bar'],
    }))
    const dirs = args.reduce<string[]>((acc, v, i) => {
      if (args[i - 1] === '--add-dir') acc.push(v)
      return acc
    }, [])
    expect(dirs).toEqual(['/foo', '/bar'])
  })

  test('sessionName is passed as --name', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agentName: 'developer', sessionName: 'chat-foo',
    }))
    expect(args).toContain('--name')
    expect(args[args.indexOf('--name') + 1]).toBe('chat-foo')
  })

  test('forwards permissionMode via --permission-mode', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agentName: 'trusted', permissionMode: 'bypassPermissions',
    }))
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
  })

  test('omits --permission-mode when unset', () => {
    const { args } = buildSubagentArgs(baseOpts({ agentName: 'untrusted' }))
    expect(args).not.toContain('--permission-mode')
  })

  test('forwards allowedTools via --allowed-tools', () => {
    // Use a real tool name (mcp__dc__reply — the cross-chat post tool;
    // registered as `reply` without a dc_ prefix) so this test doesn't
    // perpetuate the "dc_reply" naming confusion that caused the
    // original DC_TOOL_NAMES drift Oliver flagged.
    const { args } = buildSubagentArgs(baseOpts({
      agentName: 'trusted',
      allowedTools: 'Bash, Read, mcp__dc__reply',
    }))
    expect(args).toContain('--allowed-tools')
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Bash, Read, mcp__dc__reply')
  })

  test('omits --allowed-tools when allowedTools is empty', () => {
    const { args } = buildSubagentArgs(baseOpts({ agentName: 'untrusted', allowedTools: '' }))
    expect(args).not.toContain('--allowed-tools')
  })

  test('throws if agentName is missing', () => {
    expect(() => buildSubagentArgs(baseOpts({ agentName: undefined as unknown as string })))
      .toThrow(/agentName is required/)
  })
})
