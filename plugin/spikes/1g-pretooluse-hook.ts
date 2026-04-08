#!/usr/bin/env bun
/**
 * Spike 1G: does PreToolUse hook delegation work in `claude -p` mode?
 *
 * The goal is to prove that Phase 2 can preserve the existing WebXDC
 * permission-prompt UX by routing tool permission decisions through a
 * PreToolUse hook script that:
 *
 *   1. Fires synchronously before a tool call
 *   2. Can block waiting for an async response (in production, a
 *      round-trip to Delta Chat via a Unix socket)
 *   3. Can allow the call (exit 0) or deny it (exit 2)
 *
 * This spike uses a trivial hook that sleeps 2 seconds then exits 0.
 * If the hook is called and the Bash action runs, the mechanism
 * works and Phase 2's permission relay design is unblocked.
 *
 * Pass criteria:
 *   a. /tmp/spike-1g-hook.log is written (hook actually ran)
 *   b. claude stdout contains "cobalt" (Bash ran after the hook allowed it)
 *   c. Total wall-clock ≥ 2000 ms (the hook's sleep was actually awaited)
 *   d. The stream-json permission_denials array is empty
 */

import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { exitFromResult } from './lib/report.js'

interface RunResult { stdout: string; stderr: string; exitCode: number; wallMs: number }

const SETTINGS = join(import.meta.dir, '1g-settings.json')
const HOOK_LOG = '/tmp/spike-1g-hook.log'

function runClaude(prompt: string, timeoutMs = 120000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    const child = spawn(
      'claude',
      [
        '-p',
        '--settings', SETTINGS,
        '--permission-mode', 'default',
        '--output-format', 'stream-json',
        '--verbose',
        prompt,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const wallMs = performance.now() - start
      resolve({ stdout, stderr, exitCode: code ?? -1, wallMs })
    })
  })
}

async function main(): Promise<void> {
  // Wipe prior hook log
  try { unlinkSync(HOOK_LOG) } catch {}

  const r = await runClaude('Run: bash -c "echo cobalt". Reply with just the bash output.')

  const hookLogExists = existsSync(HOOK_LOG)
  const hookLog = hookLogExists ? readFileSync(HOOK_LOG, 'utf-8') : ''
  const hookFiredOnce = (hookLog.match(/^---$/gm) ?? []).length
  const hookSawBash = /"tool_name":"Bash"/.test(hookLog)

  const bashRan = /"cobalt"|>cobalt/.test(r.stdout) || /cobalt/.test(r.stdout)

  let denialCount = 0
  for (const line of r.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    try {
      const frame = JSON.parse(line) as { type?: string; permission_denials?: unknown[] }
      if (frame.type === 'result') denialCount = (frame.permission_denials ?? []).length
    } catch {}
  }

  const slowEnough = r.wallMs >= 2000

  const allPass = hookLogExists && hookFiredOnce >= 1 && bashRan && slowEnough && denialCount === 0

  exitFromResult({
    id: '1g-pretooluse-hook',
    title: 'PreToolUse hooks fire in `claude -p` and can gate tool calls',
    passed: allPass,
    verdict: allPass
      ? 'hook fired, blocked synchronously for 2s, allowed Bash to run; Phase 2 permission relay via hook+socket is viable'
      : `failures: ${[!hookLogExists && 'no hook log', hookFiredOnce < 1 && 'hook did not fire', !bashRan && 'bash did not run', !slowEnough && `wall ${r.wallMs.toFixed(0)}ms < 2000ms`, denialCount > 0 && `${denialCount} denials`].filter(Boolean).join(', ')}`,
    evidence: [
      { label: 'hook log exists', value: hookLogExists ? 'YES' : 'NO' },
      { label: 'hook invocations', value: String(hookFiredOnce) },
      { label: 'hook saw Bash tool_name', value: hookSawBash ? 'YES' : 'NO' },
      { label: 'bash output "cobalt" in stdout', value: bashRan ? 'YES' : 'NO' },
      { label: 'total wall time', value: `${r.wallMs.toFixed(0)} ms (budget ≥ 2000)` },
      { label: 'permission_denials length', value: String(denialCount) },
      { label: 'claude exit code', value: String(r.exitCode) },
      { label: 'hook log (truncated)', value: hookLog.slice(0, 200).replace(/\n/g, ' | ') },
    ],
    notes:
      'If PASS: Phase 2\'s permission relay is a PreToolUse hook shell script that (a) reads the tool_input from stdin, (b) opens the dispatcher\'s Unix socket, (c) sends a permission_request frame, (d) blocks reading the reply, (e) exits 0 for allow or 2 for deny. The dispatcher forwards to the existing permissions-app WebXDC flow, waits for the user\'s verdict, and writes the reply. This preserves the existing dc-channel UX exactly (tap Allow/Deny in DC) while working in headless -p mode. No SDK hacks, no stream-json input frames, no architectural compromise.',
  })
}

main().catch((err) => { console.error('spike 1g crashed:', err); process.exit(2) })
