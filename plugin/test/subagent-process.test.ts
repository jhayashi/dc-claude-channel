import { describe, test, expect } from 'bun:test'
import { buildSubagentArgs, planKillTree, type SubagentSpawnOptions } from '../dispatcher/subagent-process'

function baseOpts(extra: Partial<SubagentSpawnOptions> = {}): SubagentSpawnOptions {
  return {
    chatId: 7,
    subagentId: 'sub-7-abcd',
    agent: { name: 'test-agent' },
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
    const { args, envBlock } = buildSubagentArgs(baseOpts({ agent: { name: 'developer' } }))
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
    expect(envBlock).toContain('Agent name: developer')
  })

  test('a bare agent yields no --model / --effort / --permission-mode / --allowed-tools', () => {
    // CC reads model/effort/permissionMode/tools/system prompt from the .md
    // (via --agent); the dispatcher only forwards permissionMode/tools when
    // the agent carries them. A bare agent forwards none of these flags.
    const { args } = buildSubagentArgs(baseOpts({ agent: { name: 'developer' } }))
    expect(args).not.toContain('--model')
    expect(args).not.toContain('--effort')
    expect(args).not.toContain('--permission-mode')
    expect(args).not.toContain('--allowed-tools')
  })

  test('--append-system-prompt contains the env block only (no agent system prompt)', () => {
    const { args, envBlock } = buildSubagentArgs(baseOpts({ agent: { name: 'developer' } }))
    const idx = args.indexOf('--append-system-prompt')
    expect(args[idx + 1]).toBe(envBlock)
  })

  test('resume=true uses --resume', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agent: { name: 'developer' }, sessionId: 'abc-123', resume: true,
    }))
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('abc-123')
    expect(args).not.toContain('--session-id')
  })

  test('--mcp-config is still passed (DC tools-proxy)', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agent: { name: 'developer' }, mcpConfigPath: '/tmp/mcp.json',
    }))
    expect(args).toContain('--mcp-config')
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/tmp/mcp.json')
  })

  test('addDirs are passed as --add-dir', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agent: { name: 'developer' }, addDirs: ['/foo', '/bar'],
    }))
    const dirs = args.reduce<string[]>((acc, v, i) => {
      if (args[i - 1] === '--add-dir') acc.push(v)
      return acc
    }, [])
    expect(dirs).toEqual(['/foo', '/bar'])
  })

  test('sessionName is passed as --name', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agent: { name: 'developer' }, sessionName: 'chat-foo',
    }))
    expect(args).toContain('--name')
    expect(args[args.indexOf('--name') + 1]).toBe('chat-foo')
  })

  test('forwards agent.permissionMode via --permission-mode', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agent: { name: 'trusted', permissionMode: 'bypassPermissions' },
    }))
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
  })

  test('omits --permission-mode when agent.permissionMode is unset', () => {
    const { args } = buildSubagentArgs(baseOpts({ agent: { name: 'untrusted' } }))
    expect(args).not.toContain('--permission-mode')
  })

  test('forwards agent.tools via --allowed-tools', () => {
    // Use a real tool name (mcp__dc__reply — the cross-chat post tool;
    // registered as `reply` without a dc_ prefix) so this test doesn't
    // perpetuate the "dc_reply" naming confusion. The tool-name set is now
    // computed from the live registrations at boot, so there is no longer a
    // hand-maintained list to drift from.
    const { args } = buildSubagentArgs(baseOpts({
      agent: { name: 'trusted', tools: 'Bash, Read, mcp__dc__reply' },
    }))
    expect(args).toContain('--allowed-tools')
    expect(args[args.indexOf('--allowed-tools') + 1]).toBe('Bash, Read, mcp__dc__reply')
  })

  test('omits --allowed-tools when agent.tools is empty', () => {
    const { args } = buildSubagentArgs(baseOpts({ agent: { name: 'untrusted', tools: '' } }))
    expect(args).not.toContain('--allowed-tools')
  })

  test('always disallows headless-incompatible interactive tools', () => {
    // #105: AskUserQuestion/EnterPlanMode/ExitPlanMode need an interactive
    // UI `claude -p` can't provide; unconditionally deny them so a subagent
    // can never be granted one, regardless of what the agent's tools list
    // (a file shared with terminal CC) happens to contain.
    const { args } = buildSubagentArgs(baseOpts({ agent: { name: 'bare' } }))
    expect(args).toContain('--disallowed-tools')
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('AskUserQuestion,EnterPlanMode,ExitPlanMode')
  })

  test('disallows AskUserQuestion even when the agent explicitly grants it', () => {
    const { args } = buildSubagentArgs(baseOpts({
      agent: { name: 'legacy', tools: 'Bash, AskUserQuestion' },
    }))
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('AskUserQuestion,EnterPlanMode,ExitPlanMode')
  })

  test('throws if agent.name is missing', () => {
    expect(() => buildSubagentArgs(baseOpts({ agent: { name: undefined as unknown as string } })))
      .toThrow(/agent\.name is required/)
    expect(() => buildSubagentArgs(baseOpts({ agent: undefined as unknown as SubagentSpawnOptions['agent'] })))
      .toThrow(/agent\.name is required/)
  })
})

describe('planKillTree', () => {
  test('win32: force-kills the process tree via taskkill /T /F, then direct-child kill as fallback', () => {
    const steps = planKillTree('win32', 4242, [], 'SIGKILL')
    // taskkill runs first (while the tree is still intact) so /T can walk it;
    // the direct child.kill is a belt-and-suspenders fallback in case taskkill
    // is unavailable, so Windows is never worse than the pre-fix direct kill.
    expect(steps).toEqual([
      { kind: 'taskkill', argv: ['/T', '/F', '/PID', '4242'] },
      { kind: 'child-kill', signal: 'SIGKILL' },
    ])
  })

  test('win32: uses /F even for SIGTERM (Windows has no graceful tree-kill)', () => {
    const steps = planKillTree('win32', 7, [], 'SIGTERM')
    expect(steps[0]).toEqual({ kind: 'taskkill', argv: ['/T', '/F', '/PID', '7'] })
    // the fallback child-kill still carries the original signal
    expect(steps[1]).toEqual({ kind: 'child-kill', signal: 'SIGTERM' })
  })

  test('win32: descendants are ignored (taskkill /T walks the tree itself)', () => {
    const withKids = planKillTree('win32', 100, [101, 102, 103], 'SIGKILL')
    const without = planKillTree('win32', 100, [], 'SIGKILL')
    expect(withKids).toEqual(without)
  })

  test('posix: kills descendants depth-first (deepest first), then the root', () => {
    // descendants arrive BFS-ordered (shallowest first); kill in reverse so a
    // child dies before its parent.
    const steps = planKillTree('linux', 100, [101, 102, 103], 'SIGTERM')
    expect(steps).toEqual([
      { kind: 'process-kill', pid: 103, signal: 'SIGTERM' },
      { kind: 'process-kill', pid: 102, signal: 'SIGTERM' },
      { kind: 'process-kill', pid: 101, signal: 'SIGTERM' },
      { kind: 'process-kill', pid: 100, signal: 'SIGTERM' },
    ])
  })

  test('posix: with no descendants, just kills the root', () => {
    const steps = planKillTree('darwin', 55, [], 'SIGKILL')
    expect(steps).toEqual([{ kind: 'process-kill', pid: 55, signal: 'SIGKILL' }])
  })
})
