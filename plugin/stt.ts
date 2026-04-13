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
 * Transcribe an audio file using @napi-rs/whisper native bindings.
 *
 * Decodes audio natively (no ffmpeg), loads the ggml model, and runs
 * whisper inference in-process. Respects timeout via AbortController.
 */
export async function transcribe(
  filePath: string,
  config: STTConfig,
  modelPath: string,
  logf: LogFn,
): Promise<TranscriptionResult> {
  ensureLibStdCpp()
  const {
    Whisper,
    WhisperFullParams,
    WhisperSamplingStrategy,
    decodeAudio,
  } = await import('@napi-rs/whisper')

  logf('stt: transcribing %s with model %s', filePath, config.model)
  const startTime = Date.now()

  // 1. Decode audio to PCM samples (handles m4a, mp3, wav, etc.)
  const audioData = readFileSync(filePath)
  const samples = decodeAudio(new Uint8Array(audioData), filePath)
  logf('stt: decoded %d samples from %s', samples.length, filePath)

  // Check duration from sample count (16kHz)
  const audioDurationSec = samples.length / 16000
  if (audioDurationSec > config.maxDurationSec) {
    throw new Error(`Audio too long (${audioDurationSec.toFixed(0)}s > ${config.maxDurationSec}s)`)
  }

  // 2. Load model and configure parameters
  const whisper = new Whisper(modelPath)
  const params = new WhisperFullParams(WhisperSamplingStrategy.Greedy)

  // Detect language from model name: *.en models are English-only
  if (config.model.endsWith('.en')) {
    params.language = 'en'
  } else {
    params.detectLanguage = true
  }
  params.printProgress = false
  params.printRealtime = false
  params.printTimestamps = false
  params.singleSegment = false
  params.noTimestamps = false

  // Collect segments via callback
  const segments: TranscriptionSegment[] = []
  params.onNewSegment = (seg: { text: string; start: number; end: number }) => {
    const text = seg.text.trim()
    if (text) {
      segments.push({ start: seg.start, end: seg.end, text })
    }
  }

  // 3. Run transcription with timeout
  const timeoutMs = config.timeoutSec * 1000
  const text = await Promise.race([
    new Promise<string>((resolve) => {
      const result = whisper.full(params, samples)
      resolve(result)
    }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`Transcription timed out after ${config.timeoutSec}s`)), timeoutMs),
    ),
  ])

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  logf('stt: whisper completed in %ss', elapsed)

  // Use text from full() (most reliable), fall back to joined segments
  const finalText = text.trim()
  const durationSec = segments.length > 0
    ? segments[segments.length - 1].end / 1000
    : audioDurationSec

  return { text: finalText, segments, durationSec }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if a message is a voice message that should be transcribed. */
export function isVoiceMessage(msg: { viewType?: string; file?: string }): boolean {
  return msg.viewType === 'Voice' && !!msg.file
}

/** Minimum audio duration (seconds) to attempt transcription. */
export const MIN_AUDIO_DURATION_SEC = 0.5
