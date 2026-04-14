/**
 * Speech-to-text via @napi-rs/whisper (native bindings to whisper.cpp).
 *
 * Transcribes Delta Chat voice messages (.m4a) fully offline using
 * prebuilt native bindings — no cmake, no g++, no ffmpeg, no ffprobe.
 * Just `bun install` and it works.
 *
 * @napi-rs/whisper provides:
 *   - decodeAudio() for m4a/mp3/wav → Float32Array (via Symphonia)
 *   - Whisper class for ggml model loading + transcription
 *   - onNewSegment callback for per-segment timestamps
 *
 * Model files are downloaded from Hugging Face on first use.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// ── Bun + native binding compat ─────────────────────────────────────

/**
 * Bun doesn't link libstdc++ into its process (unlike Node), so native
 * .node binaries that depend on C++ symbols fail with "undefined symbol:
 * __gxx_personality_v0". Fix: use libc's dlopen with RTLD_GLOBAL to make
 * libstdc++ symbols available process-wide before loading @napi-rs/whisper.
 *
 * This is a no-op on macOS (no libstdc++ needed) and when running under Node.
 */
let _stdcppLoaded = false
function ensureLibStdCpp(): void {
  if (_stdcppLoaded || process.platform !== 'linux') return
  _stdcppLoaded = true
  try {
    const ffi = require('bun:ffi')
    const libc = ffi.dlopen('libc.so.6', {
      dlopen: { args: ['ptr', 'i32'], returns: 'ptr' },
    })
    // Find libstdc++ path via ldconfig
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

// ── Types ────────────────────────────────────────────────────────────

export type EchoMode = 'quoted' | 'silent'

export interface STTConfig {
  enabled: boolean
  model: string
  echo: EchoMode
  timeoutSec: number
  maxDurationSec: number
  modelDir: string
}

export interface TranscriptionSegment {
  start: number
  end: number
  text: string
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptionSegment[]
  durationSec: number
}

export type LogFn = (fmt: string, ...args: unknown[]) => void

// ── Worker pool ──────────────────────────────────────────────────────

let _worker: Worker | null = null
let _nextReqId = 0
interface PendingCall {
  resolve: (r: TranscriptionResult) => void
  reject: (e: Error) => void
}
const _pending = new Map<number, PendingCall>()

function getWorker(): Worker {
  if (_worker) return _worker
  const w = new Worker(new URL('./stt-worker.ts', import.meta.url).href, { type: 'module' })
  w.onmessage = (ev: MessageEvent) => {
    const { id, ok, text, segments, durationSec, error } = ev.data as {
      id: number
      ok: boolean
      text?: string
      segments?: TranscriptionSegment[]
      durationSec?: number
      error?: string
    }
    const p = _pending.get(id)
    if (!p) return
    _pending.delete(id)
    if (ok) {
      p.resolve({ text: text ?? '', segments: segments ?? [], durationSec: durationSec ?? 0 })
    } else {
      p.reject(new Error(error ?? 'unknown worker error'))
    }
  }
  w.onerror = (ev: ErrorEvent) => {
    for (const [, p] of _pending) p.reject(new Error(`stt-worker crashed: ${ev.message}`))
    _pending.clear()
    _worker = null
  }
  _worker = w
  return w
}

/** For tests/shutdown: terminate the Worker. */
export function _resetSttWorker(): void {
  if (_worker) {
    _worker.terminate()
    _worker = null
  }
  _pending.clear()
}

// ── Config ───────────────────────────────────────────────────────────

const VALID_ECHO_MODES: EchoMode[] = ['quoted', 'silent']
const DEFAULT_MODEL = 'base.en'
const DEFAULT_TIMEOUT_SEC = 120
const DEFAULT_MAX_DURATION_SEC = 300

export function parseSTTConfig(env: Record<string, string | undefined>): STTConfig {
  const enabled = env.DC_STT_ENABLED?.toLowerCase() !== 'false'
  const model = env.DC_STT_MODEL || DEFAULT_MODEL
  const echoRaw = env.DC_STT_ECHO?.toLowerCase() ?? 'quoted'
  const echo: EchoMode = VALID_ECHO_MODES.includes(echoRaw as EchoMode)
    ? (echoRaw as EchoMode)
    : 'quoted'
  const timeoutRaw = Number(env.DC_STT_TIMEOUT_SEC)
  const timeoutSec = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_SEC
  const maxDurRaw = Number(env.DC_STT_MAX_DURATION_SEC)
  const maxDurationSec = Number.isFinite(maxDurRaw) && maxDurRaw > 0 ? maxDurRaw : DEFAULT_MAX_DURATION_SEC

  const stateDir = env.DC_STATE_DIR
    || join(process.env.HOME || '~', '.claude', 'channels', 'deltachat')
  const modelDir = join(stateDir, 'whisper-models')

  return { enabled, model, echo, timeoutSec, maxDurationSec, modelDir }
}

// ── Model download ───────────────────────────────────────────────────

/** Map model name to Hugging Face filename. */
function modelFileName(model: string): string {
  return `ggml-${model}.bin`
}

/** Hugging Face URL for a model file. */
function modelUrl(model: string): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelFileName(model)}`
}

/**
 * Ensure the whisper model file exists, downloading if needed.
 * Returns the path to the model file.
 */
export async function ensureModel(
  config: STTConfig,
  logf: LogFn,
  onDownloadStart?: () => void,
): Promise<string> {
  mkdirSync(config.modelDir, { recursive: true })
  const modelPath = join(config.modelDir, modelFileName(config.model))

  if (existsSync(modelPath)) return modelPath

  logf('stt: downloading model %s from Hugging Face', config.model)
  onDownloadStart?.()

  const url = modelUrl(config.model)
  const resp = await fetch(url)
  if (!resp.ok) {
    throw new Error(`Model download failed: ${resp.status} ${resp.statusText} from ${url}`)
  }

  const arrayBuf = await resp.arrayBuffer()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(modelPath, new Uint8Array(arrayBuf))

  const sizeMB = (arrayBuf.byteLength / 1024 / 1024).toFixed(0)
  logf('stt: model %s downloaded (%s MB) to %s', config.model, sizeMB, modelPath)
  return modelPath
}

// ── Transcription ────────────────────────────────────────────────────

/**
 * Transcribe an audio file using @napi-rs/whisper via a Worker thread.
 *
 * Pre-flight duration checks run on the main thread to surface
 * AudioTooShortError without a worker round-trip. The heavy whisper.full()
 * call runs in the Worker so the event loop stays responsive during inference.
 * The Worker caches the Whisper instance across calls to avoid model-reload cost.
 */
export async function transcribe(
  filePath: string,
  config: STTConfig,
  modelPath: string,
  logf: LogFn,
): Promise<TranscriptionResult> {
  ensureLibStdCpp()

  // Pre-flight duration check on the main thread so AudioTooShortError surfaces
  // synchronously (doesn't require a worker round-trip).
  const { decodeAudio } = await import('@napi-rs/whisper')
  const audioData = readFileSync(filePath)
  const samples = decodeAudio(new Uint8Array(audioData), filePath)
  const durationSec = samples.length / 16000

  if (durationSec > config.maxDurationSec) {
    throw new Error(`Audio too long (${durationSec.toFixed(0)}s > ${config.maxDurationSec}s)`)
  }
  checkAudioDuration(durationSec)

  logf('stt: dispatching to worker: %s (%.1fs)', filePath, durationSec)
  const startTime = Date.now()
  const worker = getWorker()
  const id = ++_nextReqId

  const timeoutMs = config.timeoutSec * 1000
  let timer: ReturnType<typeof setTimeout> | undefined

  const result = await new Promise<TranscriptionResult>((resolve, reject) => {
    _pending.set(id, { resolve, reject })
    timer = setTimeout(() => {
      if (_pending.delete(id)) {
        // Worker is stuck in sync native code — terminate to prevent backlog.
        _resetSttWorker()
        reject(new Error(`Transcription timed out after ${config.timeoutSec}s`))
      }
    }, timeoutMs)
    worker.postMessage({
      id,
      filePath,
      modelPath,
      modelName: config.model,
      maxDurationSec: config.maxDurationSec,
    })
  }).finally(() => {
    if (timer) clearTimeout(timer)
  })

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  logf('stt: worker completed in %ss', elapsed)
  return result
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if a message is a voice message that should be transcribed. */
export function isVoiceMessage(msg: { viewType?: string; file?: string }): boolean {
  return msg.viewType === 'Voice' && !!msg.file
}

/** Minimum audio duration (seconds) to attempt transcription. */
export const MIN_AUDIO_DURATION_SEC = 0.5

/**
 * Thrown by `transcribe` when the decoded audio is shorter than
 * `MIN_AUDIO_DURATION_SEC`. Callers should treat this as "silently drop";
 * whisper output on sub-0.5s clips is hallucinated text.
 */
export class AudioTooShortError extends Error {
  constructor(public readonly durationSec: number) {
    super(`Audio too short (${durationSec.toFixed(2)}s < ${MIN_AUDIO_DURATION_SEC}s)`)
    this.name = 'AudioTooShortError'
  }
}

/** Throws AudioTooShortError if durationSec < MIN_AUDIO_DURATION_SEC. */
export function checkAudioDuration(durationSec: number): void {
  if (durationSec < MIN_AUDIO_DURATION_SEC) {
    throw new AudioTooShortError(durationSec)
  }
}
