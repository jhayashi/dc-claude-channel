#!/usr/bin/env bun
/**
 * Spike 1A (rewritten for the LRU persistent-subagent design).
 *
 * The original spike measured spawn-per-message latency and was based
 * on a mistaken assumption about the `--session` flag. Real numbers
 * (~6s cold, ~10s resume) killed that design. The canonical design
 * is now a persistent `claude -p` process per active chat, fed over
 * stdin with stream-json and drained over stdout with stream-json.
 *
 * This spike verifies four things about that design:
 *
 *   1. A persistent process can receive two prompts sequentially over
 *      stdin and respond to each (proves stream-json input isn't
 *      one-shot).
 *   2. Second-message round-trip (from input-frame-written to result-
 *      frame-received) is under 2000 ms — i.e. the LRU cache actually
 *      pays off versus spawn-per-message.
 *   3. Two persistent processes run concurrently without blocking each
 *      other on some shared resource.
 *   4. Idle RSS per persistent process is within 500 MB (sanity check
 *      for the default cap of 4 active subagents).
 *
 * See docs/plan-issue-1.md §"Spike 1A — Persistent-subagent round-trip
 * latency (REWRITTEN)" for context.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { exitFromResult } from './lib/report.js'

interface StreamFrame {
  type: string
  subtype?: string
  result?: string
  duration_ms?: number
  message?: unknown
  [k: string]: unknown
}

interface PersistentProcess {
  child: ChildProcessWithoutNullStreams
  pid: number
  readFrame: (predicate: (f: StreamFrame) => boolean, timeoutMs: number) => Promise<StreamFrame>
  send: (prompt: string) => void
  close: () => void
}

function startPersistent(sessionId: string): PersistentProcess {
  const child = spawn(
    'claude',
    [
      '-p',
      '--session-id', sessionId,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  )

  const frameQueue: StreamFrame[] = []
  const waiters: Array<{ predicate: (f: StreamFrame) => boolean; resolve: (f: StreamFrame) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = []
  let buf = ''

  child.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf-8')
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      let frame: StreamFrame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      let delivered = false
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i]
        if (w.predicate(frame)) {
          clearTimeout(w.timer)
          waiters.splice(i, 1)
          w.resolve(frame)
          delivered = true
          break
        }
      }
      if (!delivered) frameQueue.push(frame)
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[1a stderr ${child.pid}] ${chunk.toString('utf-8')}`)
  })

  const readFrame = (predicate: (f: StreamFrame) => boolean, timeoutMs: number): Promise<StreamFrame> => {
    for (let i = 0; i < frameQueue.length; i++) {
      if (predicate(frameQueue[i])) {
        return Promise.resolve(frameQueue.splice(i, 1)[0])
      }
    }
    return new Promise<StreamFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.predicate === predicate)
        if (idx >= 0) waiters.splice(idx, 1)
        reject(new Error(`timeout after ${timeoutMs}ms waiting for frame`))
      }, timeoutMs)
      waiters.push({ predicate, resolve, reject, timer })
    })
  }

  const send = (prompt: string): void => {
    const frame = { type: 'user', message: { role: 'user', content: prompt } }
    child.stdin.write(JSON.stringify(frame) + '\n')
  }

  const close = (): void => {
    try { child.stdin.end() } catch {}
    try { child.kill('SIGTERM') } catch {}
  }

  return { child, pid: child.pid!, readFrame, send, close }
}

function readRssKb(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf-8')
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m)
    return match ? Number(match[1]) : null
  } catch {
    return null
  }
}

async function measureRoundTrip(
  proc: PersistentProcess,
  prompt: string,
  timeoutMs: number,
): Promise<{ wallMs: number; reportedMs: number | undefined; result: string }> {
  const start = performance.now()
  proc.send(prompt)
  const frame = await proc.readFrame(
    (f) => f.type === 'result' && f.subtype === 'success',
    timeoutMs,
  )
  const wallMs = performance.now() - start
  return {
    wallMs,
    reportedMs: frame.duration_ms,
    result: (frame.result ?? '').toString(),
  }
}

async function main(): Promise<void> {
  const sessionId = randomUUID()
  const proc = startPersistent(sessionId)

  await new Promise((r) => setTimeout(r, 1000))

  const first = await measureRoundTrip(
    proc,
    'Remember: the secret word is cobalt. Reply with just "ok".',
    60000,
  )
  const second = await measureRoundTrip(
    proc,
    'What was the secret word? Reply with just the word.',
    60000,
  )

  const persistentOk = first.result.length > 0 && second.result.length > 0
  const roundTripOk = second.wallMs < 2000
  const continuityOk = /cobalt/i.test(second.result)

  const rssKb = readRssKb(proc.pid)
  const rssMb = rssKb !== null ? rssKb / 1024 : null
  const rssOk = rssMb !== null && rssMb <= 500

  proc.close()

  const p1 = startPersistent(randomUUID())
  const p2 = startPersistent(randomUUID())
  await new Promise((r) => setTimeout(r, 1000))
  const parallelStart = performance.now()
  const [r1, r2] = await Promise.all([
    measureRoundTrip(p1, 'Count slowly: 1 2 3 4 5. Reply with just those 5 numbers space-separated.', 60000),
    measureRoundTrip(p2, 'Count slowly: 6 7 8 9 10. Reply with just those 5 numbers space-separated.', 60000),
  ])
  const parallelWallMs = performance.now() - parallelStart
  p1.close()
  p2.close()

  const slower = Math.max(r1.wallMs, r2.wallMs)
  const parallelOk = parallelWallMs < slower * 1.5 + 500

  const allPass = persistentOk && roundTripOk && continuityOk && rssOk && parallelOk

  const verdictParts: string[] = []
  if (!persistentOk) verdictParts.push('persistent mode broken (empty result)')
  if (!roundTripOk) verdictParts.push(`2nd msg round-trip ${second.wallMs.toFixed(0)}ms ≥ 2000ms budget`)
  if (!continuityOk) verdictParts.push('in-process context continuity broken')
  if (!rssOk) verdictParts.push(rssMb === null ? 'could not read RSS' : `RSS ${rssMb.toFixed(0)}MB > 500MB`)
  if (!parallelOk) verdictParts.push(`parallel wall ${parallelWallMs.toFixed(0)}ms not within 1.5×${slower.toFixed(0)}ms`)
  if (allPass) verdictParts.push('persistent subagent design is viable')

  exitFromResult({
    id: '1a-named-sessions',
    title: 'Persistent-subagent round-trip latency',
    passed: allPass,
    verdict: verdictParts.join('; '),
    evidence: [
      { label: '1. persistent mode: both prompts answered', value: persistentOk ? 'PASS' : 'FAIL' },
      { label: '   → msg1 wall', value: `${first.wallMs.toFixed(0)} ms (api ${first.reportedMs ?? '?'})` },
      { label: '   → msg1 result', value: first.result.trim().slice(0, 60) },
      { label: '   → msg2 wall', value: `${second.wallMs.toFixed(0)} ms (api ${second.reportedMs ?? '?'})` },
      { label: '   → msg2 result', value: second.result.trim().slice(0, 60) },
      { label: '2. 2nd msg round-trip < 2000 ms', value: roundTripOk ? 'PASS' : 'FAIL' },
      { label: '3. parallelism across two processes', value: parallelOk ? 'PASS' : 'FAIL' },
      { label: '   → parallel wall', value: `${parallelWallMs.toFixed(0)} ms` },
      { label: '   → slower individual', value: `${slower.toFixed(0)} ms` },
      { label: '   → msg1 result', value: r1.result.trim().slice(0, 60) },
      { label: '   → msg2 result', value: r2.result.trim().slice(0, 60) },
      { label: '4. idle RSS ≤ 500 MB', value: rssMb !== null ? `${rssMb.toFixed(0)} MB` : 'UNKNOWN' },
      { label: 'in-process continuity (bonus)', value: continuityOk ? 'PASS (cobalt recalled)' : 'FAIL' },
    ],
    notes: 'This spike validates the LRU persistent-subagent design. A passing run means the dispatcher can keep up to DC_SUBAGENT_MAX_ACTIVE (default 4) processes alive, each with one chat\'s context resident, and get sub-2s per-message turnaround after the first.',
  })
}

main().catch((err) => {
  console.error('spike 1a crashed:', err)
  process.exit(2)
})
