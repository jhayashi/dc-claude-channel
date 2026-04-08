#!/usr/bin/env bun
/**
 * Spike 1E driver. Loads the spike-1e MCP server via --mcp-config,
 * asks Claude to run a Bash command in --permission-mode=default, and
 * watches two evidence channels for a permission-flavored frame:
 *
 *   1. The MCP server's own inbound log (/tmp/spike-1e-server.log)
 *   2. claude -p's stream-json stdout
 *
 * If either channel has a frame whose type/method/name contains
 * "permission", a permission delegation hook exists — Phase 2 can
 * wire the dispatcher into it. If neither channel has one, permission
 * delegation to MCP servers is not supported and Phase 2 must use a
 * different mechanism (documented in notes).
 */

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { exitFromResult } from './lib/report.js'

const LOG = '/tmp/spike-1e-server.log'
const CONFIG = join(import.meta.dir, '1e-mcp.config.json')

function runClaude(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      [
        '-p',
        '--mcp-config', CONFIG,
        '--permission-mode', 'default',
        '--output-format', 'stream-json',
        '--verbose',
        'Run: bash -c "echo cobalt". Reply with just the bash output.',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120000)
    child.on('error', reject)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }) })
  })
}

async function main(): Promise<void> {
  writeFileSync(LOG, '')
  const r = await runClaude()

  const mcpLog = existsSync(LOG) ? readFileSync(LOG, 'utf-8') : ''
  // Only count real permission operations, not metadata fields like
  // "permissionMode": "default" or "permission_denials": [].
  const permissionOpRe = /"(method|type|subtype|name)"\s*:\s*"[a-z_]*permission[a-z_]*(\/[a-z_]+)?"/i
  const mcpSawPermissionOp = permissionOpRe.test(mcpLog)
  const mcpSawCallTool = /"method"\s*:\s*"tools\/call"/.test(mcpLog) || /callTool/.test(mcpLog)
  const mcpStarted = /start:/.test(mcpLog)

  const claudeSawPermissionOp = permissionOpRe.test(r.stdout)
  const claudeSawBash = /"name"\s*:\s*"Bash"/.test(r.stdout) || /"command"\s*:\s*"bash/.test(r.stdout)
  // A denied permission shows up as a non-empty permission_denials array.
  const sawDenial = /"permission_denials"\s*:\s*\[\s*\{/.test(r.stdout)

  const passed = mcpSawPermissionOp || claudeSawPermissionOp || sawDenial

  exitFromResult({
    id: '1e-permission-channel',
    title: 'Can an MCP server receive built-in tool permission prompts?',
    passed,
    verdict: passed
      ? (mcpSawPermissionOp ? 'MCP server received a real permission operation' : 'claude stream-json emitted a real permission operation or denial')
      : 'no permission operation seen on either channel; MCP servers cannot act as permission channels for built-in tools',
    evidence: [
      { label: 'MCP server started', value: mcpStarted ? 'YES' : 'NO' },
      { label: 'MCP saw tools/call frame', value: mcpSawCallTool ? 'YES' : 'NO' },
      { label: 'MCP saw real permission op', value: mcpSawPermissionOp ? 'YES' : 'NO' },
      { label: 'claude stdout mentions Bash tool_use', value: claudeSawBash ? 'YES' : 'NO' },
      { label: 'claude stdout contained real permission op', value: claudeSawPermissionOp ? 'YES' : 'NO' },
      { label: 'claude stdout contained a denial', value: sawDenial ? 'YES' : 'NO' },
      { label: 'claude exit code', value: String(r.exitCode) },
      { label: 'MCP log path', value: LOG },
    ],
    notes:
      'If FAIL: Phase 2\'s permission relay cannot flow through the tools proxy. ' +
      'Realistic fallback for subagents: launch with --permission-mode=acceptEdits or ' +
      '--dangerously-skip-permissions, relying on the chat-owner pairing as the trust boundary ' +
      '(the user has already authorized the chat; they implicitly authorize its subagent). ' +
      'Document in SECURITY.md.',
  })
}

main().catch((err) => { console.error('spike 1e crashed:', err); process.exit(2) })
