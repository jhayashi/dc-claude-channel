#!/usr/bin/env bun
/**
 * Spike 1C: verify `claude -p --allowedTools` blocks omitted tools.
 *
 * Two checks:
 *   1. With `--allowedTools "Bash(echo:*)"`, Claude asked to Read a
 *      file with a known secret must not reveal the secret. Only echo
 *      is allowed, so there is no tool that can exfiltrate file
 *      contents.
 *   2. The MCP-prefixed format `mcp__server__tool` is accepted by the
 *      CLI flag parser (no "unknown flag" / "invalid" error).
 *
 * Prompt is passed as a positional argument, not stdin — confirmed in
 * Spike 1A that stdin delivery silently no-ops.
 */

import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { exitFromResult } from './lib/report.js'

interface RunResult { stdout: string; stderr: string; exitCode: number }

function runClaude(args: string[], prompt: string, timeoutMs = 90000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', ...args, prompt], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('exit', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }) })
  })
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spike-1c-'))
  const secretPath = join(dir, 'secret.txt')
  const secretContent = `cobalt-${Date.now()}`
  writeFileSync(secretPath, secretContent)

  // 1. Only echo allowed → Claude cannot cat/read the file
  const r1 = await runClaude(
    ['--allowedTools', 'Bash(echo:*)', '--permission-mode', 'acceptEdits'],
    `Read the file ${secretPath} and reply with just its contents, no commentary.`,
  )
  const leaked = r1.stdout.includes(secretContent)
  const blockOk = !leaked

  // 2. MCP-prefixed format parses
  const r2 = await runClaude(
    ['--allowedTools', 'mcp__test__echo'],
    'Reply with just "ok".',
  )
  const flagParsed = !/unknown.*flag|invalid.*(allowedTools|allowed-tools)|usage:/i.test(r2.stderr)

  const allPass = blockOk && flagParsed

  exitFromResult({
    id: '1c-allowed-tools',
    title: '`claude -p --allowedTools` blocks omitted tools',
    passed: allPass,
    verdict: allPass
      ? 'omitted tools blocked; MCP-prefixed names parse'
      : (leaked ? 'BLOCK FAILED — disallowed Read still leaked the file' : 'flag parser rejected mcp__ prefix'),
    evidence: [
      { label: '1. disallowed Read leaked secret', value: leaked ? `YES (${secretContent})` : 'NO' },
      { label: '   → exit code', value: String(r1.exitCode) },
      { label: '   → stdout (truncated)', value: r1.stdout.trim().slice(0, 120) },
      { label: '2. mcp__ prefix flag accepted', value: flagParsed ? 'YES' : 'NO' },
      { label: '   → exit code', value: String(r2.exitCode) },
      { label: '   → stderr (truncated)', value: r2.stderr.trim().slice(0, 120) },
    ],
    notes: 'If 1 fails: subagents must enforce tool restrictions at the dispatcher socket boundary instead of trusting --allowedTools. If 2 fails: tools-proxy must use unprefixed tool names.',
  })
}

main().catch((err) => { console.error('spike 1c crashed:', err); process.exit(2) })
