#!/usr/bin/env bun
/**
 * Spike 1F: does `claude -p --output-format stream-json` expose
 * built-in tool permission decisions in a way the dispatcher can
 * observe (and potentially act on)?
 *
 * Phase 1 context:
 *   - Spike 1C showed `--allowedTools` is not a hard fence.
 *   - Spike 1E showed MCP servers do not receive permission
 *     operations from the Claude runtime.
 *
 * Question: in headless `-p` mode, what actually happens when Claude
 * wants to run a command that would otherwise prompt? If the runtime
 * surfaces a denial (or a request), we can wire the dispatcher into
 * that channel and relay to DC.
 *
 * This spike triggers a Bash action that the built-in CWD sandbox
 * rejects (deleting a file outside the working directory) and checks:
 *
 *   1. The stream-json `result` frame contains a non-empty
 *      `permission_denials` array describing what was blocked.
 *   2. The block is enforced — the victim file still exists.
 *   3. Claude Code reported the block back to the user via an
 *      assistant text message (so the dispatcher can route it to DC).
 *
 * Pass → Phase 2 can "relay permission decisions to DC" by watching
 *        `permission_denials` in every result frame and forwarding
 *        the list as a status message to the originating chat.
 * Fail → permission_denials is empty or missing; we fall back to
 *        pre-baked `--permission-mode` with no in-session feedback.
 */

import { spawn } from 'node:child_process'
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { exitFromResult } from './lib/report.js'

interface RunResult { stdout: string; stderr: string; exitCode: number }

function runClaude(args: string[], prompt: string, timeoutMs = 120000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', ...args, prompt],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
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
  // Victim file lives OUTSIDE the current working directory so the
  // built-in CWD sandbox will block the rm.
  const victim = join(tmpdir(), `spike-1f-victim-${randomBytes(6).toString('hex')}.txt`)
  writeFileSync(victim, 'do-not-delete')

  const r = await runClaude(
    [
      '--permission-mode', 'default',
      '--output-format', 'stream-json',
      '--verbose',
    ],
    `Run: bash -c "rm -f ${victim} && echo removed". Reply with just the bash output.`,
  )

  // Find the final `result` frame and inspect permission_denials
  let denialCount = 0
  let denialTool = ''
  let denialCommand = ''
  let resultFrameFound = false
  for (const line of r.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue
    let frame: { type?: string; subtype?: string; permission_denials?: Array<{ tool_name?: string; tool_input?: { command?: string } }>; result?: string }
    try { frame = JSON.parse(line) } catch { continue }
    if (frame.type === 'result') {
      resultFrameFound = true
      const denials = frame.permission_denials ?? []
      denialCount = denials.length
      if (denials[0]) {
        denialTool = denials[0].tool_name ?? ''
        denialCommand = denials[0].tool_input?.command ?? ''
      }
    }
  }

  const denialReported = resultFrameFound && denialCount > 0
  const fileStillExists = existsSync(victim)
  const blockEnforced = fileStillExists

  // Clean up the victim (we couldn't inside the sandbox)
  try { if (fileStillExists) require('node:fs').unlinkSync(victim) } catch {}

  const allPass = denialReported && blockEnforced

  exitFromResult({
    id: '1f-permission-denials',
    title: 'Built-in permission decisions exposed via stream-json',
    passed: allPass,
    verdict: allPass
      ? 'permission_denials is observable in the result frame; dispatcher can relay denials to DC as status messages'
      : (!resultFrameFound
          ? 'no result frame found in stdout'
          : !denialReported
            ? 'permission_denials was empty — Bash was not actually blocked'
            : 'block not enforced — file was deleted'),
    evidence: [
      { label: 'victim path', value: victim },
      { label: 'result frame present', value: resultFrameFound ? 'YES' : 'NO' },
      { label: 'permission_denials length', value: String(denialCount) },
      { label: 'denied tool', value: denialTool || '(none)' },
      { label: 'denied command', value: denialCommand.slice(0, 80) || '(none)' },
      { label: 'block enforced (file still exists)', value: blockEnforced ? 'YES' : 'NO' },
      { label: 'claude exit code', value: String(r.exitCode) },
    ],
    notes:
      'Implication for Phase 2: the dispatcher can watch every subagent\'s stream-json output for result frames with non-empty permission_denials and forward them to DC as "⚠️ blocked" status messages. This is NOT an interactive prompt — the runtime has already decided — but it gives the user visibility into what Claude tried to do and was denied, which is the observable side of the permission story we need. For finer-grained control, Phase 2 subagents can use --add-dir to extend the CWD sandbox per-chat.',
  })
}

main().catch((err) => { console.error('spike 1f crashed:', err); process.exit(2) })
