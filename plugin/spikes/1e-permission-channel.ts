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
  const mcpSawPermission = /permission/i.test(mcpLog)
  const mcpSawCallTool = /callTool/.test(mcpLog)
  const mcpStarted = /start:/.test(mcpLog)

  const claudeSawPermission = /permission/i.test(r.stdout)
  const claudeSawBash = /"name"\s*:\s*"Bash"/.test(r.stdout) || /bash/.test(r.stdout)

  const passed = mcpSawPermission || claudeSawPermission

  exitFromResult({
    id: '1e-permission-channel',
    title: 'Can an MCP server receive built-in tool permission prompts?',
    passed,
    verdict: passed
      ? (mcpSawPermission ? 'MCP server received a permission frame' : 'claude stream-json emitted a permission frame')
      : 'no permission frame seen on either channel; MCP servers cannot act as permission channels for built-in tools',
    evidence: [
      { label: 'MCP server started', value: mcpStarted ? 'YES' : 'NO' },
      { label: 'MCP saw callTool frame', value: mcpSawCallTool ? 'YES' : 'NO' },
      { label: 'MCP saw "permission" frame', value: mcpSawPermission ? 'YES' : 'NO' },
      { label: 'claude stdout mentions Bash', value: claudeSawBash ? 'YES' : 'NO' },
      { label: 'claude stdout mentions permission', value: claudeSawPermission ? 'YES' : 'NO' },
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
