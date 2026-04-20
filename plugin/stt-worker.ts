/**
 * Bun Worker for STT inference.
 *
 * Owns a single cached Whisper instance per modelPath so each voice message
 * doesn't pay the ~150MB model-reload cost. Runs in a dedicated thread so
 * the synchronous whisper.full() call doesn't block the V8 event loop.
 *
 * Messages in:  { id, filePath, modelPath, modelName, maxDurationSec }
 * Messages out: { id, ok: true, text, segments, durationSec }
 *             | { id, ok: false, error }
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

declare const self: Worker

// ── Bun + native binding compat ─────────────────────────────────────

let _stdcppLoaded = false
function ensureLibStdCpp(): void {
  if (_stdcppLoaded || process.platform !== 'linux') return
  _stdcppLoaded = true
  try {
    const ffi = require('bun:ffi')
    const libc = ffi.dlopen('libc.so.6', {
      dlopen: { args: ['ptr', 'i32'], returns: 'ptr' },
    })
    const ldOutput = execFileSync('ldconfig', ['-p'], { encoding: 'utf8' })
    const match = ldOutput.match(/=>\s*(\/\S+libstdc\+\+\.so\.\d+)/)
    if (!match) return
    const pathBuf = Buffer.from(match[1] + '\0')
    const RTLD_LAZY_GLOBAL = 0x101 // RTLD_LAZY | RTLD_GLOBAL
    libc.symbols.dlopen(ffi.ptr(pathBuf), RTLD_LAZY_GLOBAL)
  } catch {
    // Not running under Bun, or libstdc++ not found — let the import fail naturally
  }
}

// ── Cached whisper instance ──────────────────────────────────────────

let cached: { path: string; whisper: unknown } | null = null

// ── Message handler ──────────────────────────────────────────────────

self.onmessage = async (ev: MessageEvent) => {
  const req = ev.data as {
    id: number
    filePath: string
    modelPath: string
    modelName: string
    maxDurationSec: number
  }

  try {
    ensureLibStdCpp()

    const { Whisper, WhisperFullParams, WhisperSamplingStrategy, decodeAudio } =
      await import('@napi-rs/whisper')

    const audioData = readFileSync(req.filePath)
    const samples = decodeAudio(new Uint8Array(audioData), req.filePath)
    const durationSec = samples.length / 16000

    if (durationSec > req.maxDurationSec) {
      throw new Error(`Audio too long (${durationSec.toFixed(0)}s > ${req.maxDurationSec}s)`)
    }

    if (!cached || cached.path !== req.modelPath) {
      cached = { path: req.modelPath, whisper: new Whisper(req.modelPath) }
    }
    const whisper = cached.whisper as InstanceType<typeof Whisper>

    const params = new WhisperFullParams(WhisperSamplingStrategy.Greedy)

    if (req.modelName.endsWith('.en')) {
      params.language = 'en'
    } else {
      // 'auto' = detect language, then transcribe. Setting detectLanguage=true
      // puts whisper in detect-only mode and skips transcription entirely.
      params.language = 'auto'
    }
    params.printProgress = false
    params.printRealtime = false
    params.printTimestamps = false
    params.singleSegment = false
    params.noTimestamps = false

    const segments: { start: number; end: number; text: string }[] = []
    params.onNewSegment = (seg: { text: string; start: number; end: number }) => {
      const text = seg.text.trim()
      if (text) segments.push({ start: seg.start, end: seg.end, text })
    }

    const text = whisper.full(params, samples)
    const finalDuration =
      segments.length > 0 ? segments[segments.length - 1].end / 1000 : durationSec

    self.postMessage({
      id: req.id,
      ok: true,
      text: text.trim(),
      segments,
      durationSec: finalDuration,
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    self.postMessage({ id: req.id, ok: false, error: msg })
  }
}
