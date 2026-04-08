/**
 * Generate a `--settings` JSON file for a per-subagent PreToolUse
 * hook. The generated file is written to a temp path and its path
 * is returned; the caller passes it to claude -p --settings.
 *
 * The hook is configured to fire on the tool patterns we care about
 * for safety: Bash, Edit, Write, NotebookEdit, WebFetch. Read/Grep/
 * Glob are not gated — same posture the TUI uses by default.
 */

import { writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'

export interface ToolDef {
  name: string
  description: string
  inputSchema: unknown
}

export interface HookConfigInput {
  hookScriptPath: string
  /** Tools that should fire the permission hook. Defaults to the "dangerous" set. */
  gatedTools?: string[]
  /** Path to plugin/dispatcher/tools-proxy.ts (run via bun). */
  toolsProxyPath: string
  /** Tool definitions exposed via the dc-tools-proxy MCP server. */
  toolDefs: ToolDef[]
}

export const DEFAULT_GATED_TOOLS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch']

export interface GeneratedHookConfig {
  settingsPath: string
  mcpConfigPath: string
  manifestPath: string
  /** Directory containing settingsPath — caller should rm -rf on cleanup. */
  tempDir: string
}

export function generateHookConfig(input: HookConfigInput): GeneratedHookConfig {
  const gated = input.gatedTools ?? DEFAULT_GATED_TOOLS
  const dir = mkdtempSync(join(tmpdir(), 'dc-subagent-'))
  const settingsPath = join(dir, 'settings.json')
  const mcpConfigPath = join(dir, 'mcp-config.json')
  const manifestPath = join(dir, 'tools-manifest.json')

  const settings = {
    hooks: {
      PreToolUse: gated.map((matcher) => ({
        matcher,
        hooks: [{ type: 'command', command: input.hookScriptPath }],
      })),
    },
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

  writeFileSync(manifestPath, JSON.stringify(input.toolDefs, null, 2))

  const mcpConfig = {
    mcpServers: {
      dc: {
        command: 'bun',
        args: ['run', input.toolsProxyPath],
        env: {
          DC_TOOLS_MANIFEST: manifestPath,
        },
      },
    },
  }
  writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2))

  return { settingsPath, mcpConfigPath, manifestPath, tempDir: dir }
}
