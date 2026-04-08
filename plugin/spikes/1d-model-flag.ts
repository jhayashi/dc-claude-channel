#!/usr/bin/env bun
/**
 * Spike 1D: verify `claude -p --model <id>` works in headless mode for
 * haiku, sonnet, and opus. Phase 4 is gated on this.
 *
 * Prompt is positional, not stdin — confirmed in Spike 1A that stdin
 * delivery silently no-ops.
 */

import { spawn } from 'node:child_process'
import { exitFromResult } from './lib/report.js'

interface RunResult { ok: boolean; stderr: string; stdout: string; exitCode: number }

function runClaude(model: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'claude',
      ['-p', '--model', model, 'Reply with just "ok".'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    const timer = setTimeout(() => child.kill('SIGKILL'), 90000)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      const flagRejected = /unknown.*model|invalid.*model|error.*model|usage:/i.test(stderr)
      resolve({ ok: code === 0 && !flagRejected, stderr, stdout, exitCode: code ?? -1 })
    })
  })
}

async function main(): Promise<void> {
  const haiku = await runClaude('haiku')
  const sonnet = await runClaude('sonnet')
  const opus = await runClaude('opus')

  const allPass = haiku.ok && sonnet.ok && opus.ok

  exitFromResult({
    id: '1d-model-flag',
    title: '`claude -p --model` accepts haiku/sonnet/opus',
    passed: allPass,
    verdict: allPass
      ? 'all three model aliases accepted in headless mode'
      : `failures: ${[!haiku.ok && 'haiku', !sonnet.ok && 'sonnet', !opus.ok && 'opus'].filter(Boolean).join(', ')}`,
    evidence: [
      { label: '--model haiku exit', value: String(haiku.exitCode) },
      { label: '   → stdout', value: haiku.stdout.trim().slice(0, 80) },
      { label: '   → stderr', value: haiku.stderr.trim().slice(0, 120) },
      { label: '--model sonnet exit', value: String(sonnet.exitCode) },
      { label: '   → stdout', value: sonnet.stdout.trim().slice(0, 80) },
      { label: '   → stderr', value: sonnet.stderr.trim().slice(0, 120) },
      { label: '--model opus exit', value: String(opus.exitCode) },
      { label: '   → stdout', value: opus.stdout.trim().slice(0, 80) },
      { label: '   → stderr', value: opus.stderr.trim().slice(0, 120) },
    ],
    notes: 'If any fail, Phase 4 (per-group model selection) is cut from v0.9.',
  })
}

main().catch((err) => { console.error('spike 1d crashed:', err); process.exit(2) })
