import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Regression guard for the cold-spawn deadlock (May 2026 incident:
 * "all chats hang with timeout after 3600000ms").
 *
 * Subagents spawn with cwd = the plugin dir and run under
 * `permissionMode: bypassPermissions`, which makes Claude Code auto-load the
 * project-scoped `.mcp.json`. If that file declares an MCP server that boots
 * the dispatcher itself (`bun … start` or `server.ts`), every COLD subagent
 * spawn launches a rival dispatcher, which blocks forever on the DC
 * account-DB file lock the live dispatcher holds. Claude then emits zero
 * output and the turn dies at the 1-hour timeout.
 *
 * Subagents get the DC tools from the per-subagent tools-proxy mcp-config the
 * dispatcher generates (server name `dc`), NOT from this file — so the project
 * `.mcp.json` must never re-launch the dispatcher.
 */
describe('plugin/.mcp.json', () => {
  const raw = readFileSync(join(import.meta.dir, '..', '.mcp.json'), 'utf-8')
  const parsed = JSON.parse(raw) as {
    mcpServers?: Record<string, { command?: string; args?: string[] }>
  }

  test('is valid JSON with an mcpServers object', () => {
    expect(typeof parsed.mcpServers).toBe('object')
  })

  test('declares no MCP server that re-launches the dispatcher', () => {
    const offenders = Object.entries(parsed.mcpServers ?? {})
      .map(([name, def]) => ({
        name,
        invocation: [def.command ?? '', ...(def.args ?? [])].join(' '),
      }))
      // `bun run … start` (the package "start" script) and a direct
      // `server.ts` invocation both boot the dispatcher.
      .filter(
        ({ invocation }) =>
          /\bserver\.ts\b/.test(invocation) || /(^|\s)start(\s|$)/.test(invocation),
      )
    expect(offenders).toEqual([])
  })
})
