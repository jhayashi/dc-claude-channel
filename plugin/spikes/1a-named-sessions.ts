#!/usr/bin/env bun
/**
 * Spike 1A: named sessions for headless `claude -p`.
 *
 * Verifies four sub-questions:
 *   1. continuity: --session <id> persists context across calls
 *   2. parallelism: concurrent --session <different-id> truly parallel
 *   3. cold-start latency < 1500 ms
 *   4. warm-start latency < 500 ms
 *
 * See docs/plan-issue-1.md §"Spike 1A" for context.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { exitFromResult, type SpikeResult } from './lib/report.js'

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  spawnToFirstByteMs: number
  spawnToExitMs: number
}

function runClaude(args: string[], prompt: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let firstByte: number | null = null
    const child = spawn('claude', ['-p', ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (firstByte === null) firstByte = performance.now()
      stdout += chunk.toString('utf-8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8')
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      const end = performance.now()
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        spawnToFirstByteMs: (firstByte ?? end) - start,
        spawnToExitMs: end - start,
      })
    })
    child.stdin.end(prompt)
  })
}

async function main(): Promise<void> {
  const sessionId = `spike-1a-${randomUUID()}`
  const otherSessionId = `spike-1a-${randomUUID()}`

  // 1. Continuity
  const first = await runClaude(
    ['--session', sessionId],
    'Remember that my favorite color is cobalt. Reply with just "ok".',
  )
  const second = await runClaude(
    ['--session', sessionId],
    'What is my favorite color? Reply with just the color name.',
  )
  const continuityPass = /cobalt/i.test(second.stdout)

  // 2. Parallelism — two concurrent calls with slow Bash should overlap
  const parallelStart = performance.now()
  const [pa, pb] = await Promise.all([
    runClaude(
      ['--session', `spike-1a-par-a-${randomUUID()}`],
      'Run: bash -c "sleep 3 && echo done-a". Reply with just the bash output.',
    ),
    runClaude(
      ['--session', `spike-1a-par-b-${randomUUID()}`],
      'Run: bash -c "sleep 3 && echo done-b". Reply with just the bash output.',
    ),
  ])
  const parallelWallMs = performance.now() - parallelStart
  // Serial would be ~6s+overhead, parallel should be < 5s
  const parallelPass = parallelWallMs < 5000

  // 3. Cold-start latency — fresh session, no-op prompt
  const cold = await runClaude(
    ['--session', `spike-1a-cold-${randomUUID()}`],
    'Reply with just "x".',
  )
  const coldPass = cold.spawnToFirstByteMs < 1500

  // 4. Warm-start latency — re-use the continuity session
  const warm = await runClaude(
    ['--session', sessionId],
    'Reply with just "y".',
  )
  const warmPass = warm.spawnToFirstByteMs < 500

  const allPass = continuityPass && parallelPass && coldPass && warmPass

  const verdictParts: string[] = []
  if (continuityPass) verdictParts.push('continuity OK')
  else verdictParts.push('continuity FAILED — fallback: explicit dc_chat_history injection in prompt')
  if (parallelPass) verdictParts.push('parallelism OK')
  else verdictParts.push('parallelism FAILED — claude -p serializes; loses concurrency wins')
  if (coldPass) verdictParts.push('cold-start within budget')
  else verdictParts.push(`cold-start ${cold.spawnToFirstByteMs.toFixed(0)}ms exceeds 1500ms budget — Phase 2.5 mandatory`)
  if (warmPass) verdictParts.push('warm-start within budget')
  else verdictParts.push(`warm-start ${warm.spawnToFirstByteMs.toFixed(0)}ms exceeds 500ms budget`)

  const result: SpikeResult = {
    id: '1a-named-sessions',
    title: 'Named sessions for headless `claude -p`',
    passed: allPass,
    verdict: verdictParts.join('; '),
    evidence: [
      { label: '1. continuity (second call sees first)', value: continuityPass ? 'PASS' : 'FAIL' },
      { label: '   → second.stdout', value: second.stdout.trim().slice(0, 80) },
      { label: '2. parallel two-chat wall time', value: `${parallelWallMs.toFixed(0)} ms (budget < 5000)` },
      { label: '   → call A spawn→exit', value: `${pa.spawnToExitMs.toFixed(0)} ms` },
      { label: '   → call B spawn→exit', value: `${pb.spawnToExitMs.toFixed(0)} ms` },
      { label: '3. cold-start spawn→first byte', value: `${cold.spawnToFirstByteMs.toFixed(0)} ms (budget < 1500)` },
      { label: '4. warm-start spawn→first byte', value: `${warm.spawnToFirstByteMs.toFixed(0)} ms (budget < 500)` },
    ],
    notes: 'If continuity fails, fallback is documented in plan §"Fallback if 1A.1 fails". If cold-start fails, Phase 2.5 (warm pool) becomes mandatory.',
  }

  exitFromResult(result)
}

main().catch((err) => {
  console.error('spike 1a crashed:', err)
  process.exit(2)
})
