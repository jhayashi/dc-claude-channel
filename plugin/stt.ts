/**
 * Speech-to-text via local whisper.cpp.
 *
 * Transcribes Delta Chat voice messages (.m4a) offline by:
 *   1. Converting .m4a → 16kHz mono .wav via ffmpeg
 *   2. Running whisper.cpp via Bun.spawn() with --output-json
 *   3. Parsing JSON output including per-segment avg_logprob
 *
 * Calls whisper.cpp directly (not through nodejs-whisper) so we get:
 *   - Child process handle for timeout/kill
 *   - Real avg_logprob for confidence gating
 *   - Full control over CLI flags and cleanup
 *
 * Model files are downloaded from Hugging Face on first use.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'

// ── Types ────────────────────────────────────────────────────────────

export type EchoMode = 'quoted' | 'silent'

export interface STTConfig {
  enabled: boolean
  model: string
  echo: EchoMode
  confidenceThreshold: number
  timeoutSec: number
  maxDurationSec: number
  modelDir: string
}

export interface TranscriptionSegment {
  start: number
  end: number
  text: string
  avg_logprob: number
}

export interface TranscriptionResult {
  text: string
  confidence: number
  segments: TranscriptionSegment[]
  durationSec: number
}

export type LogFn = (fmt: string, ...args: unknown[]) => void

// ── Config ───────────────────────────────────────────────────────────

const VALID_ECHO_MODES: EchoMode[] = ['quoted', 'silent']
const DEFAULT_MODEL = 'base.en'
const DEFAULT_CONFIDENCE = -1.0
const DEFAULT_TIMEOUT_SEC = 120
const DEFAULT_MAX_DURATION_SEC = 300

export function parseSTTConfig(env: Record<string, string | undefined>): STTConfig {
  const enabled = env.DC_STT_ENABLED?.toLowerCase() !== 'false'
  const model = env.DC_STT_MODEL || DEFAULT_MODEL
  const echoRaw = env.DC_STT_ECHO?.toLowerCase() ?? 'quoted'
  const echo: EchoMode = VALID_ECHO_MODES.includes(echoRaw as EchoMode)
    ? (echoRaw as EchoMode)
    : 'quoted'
  const confRaw = Number(env.DC_STT_CONFIDENCE)
  const confidenceThreshold = Number.isFinite(confRaw) ? confRaw : DEFAULT_CONFIDENCE
  const timeoutRaw = Number(env.DC_STT_TIMEOUT_SEC)
  const timeoutSec = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : DEFAULT_TIMEOUT_SEC
  const maxDurRaw = Number(env.DC_STT_MAX_DURATION_SEC)
  const maxDurationSec = Number.isFinite(maxDurRaw) && maxDurRaw > 0 ? maxDurRaw : DEFAULT_MAX_DURATION_SEC

  const stateDir = env.DC_STATE_DIR
    || join(process.env.HOME || '~', '.claude', 'channels', 'deltachat')
  const modelDir = join(stateDir, 'whisper-models')

  return { enabled, model, echo, confidenceThreshold, timeoutSec, maxDurationSec, modelDir }
}

// ── System dependency checks ─────────────────────────────────────────

/** Whisper binary names to search for, in priority order. */
const WHISPER_BINARIES = ['whisper-cli', 'whisper.cpp', 'whisper', 'main']

let cachedWhisperPath: string | null = null
let whisperChecked = false

/**
 * Find the whisper.cpp binary on the system.
 * Returns the path if found, null otherwise. Result is cached.
 */
export async function findWhisperBinary(): Promise<string | null> {
  if (whisperChecked) return cachedWhisperPath
  for (const name of WHISPER_BINARIES) {
    const result = Bun.spawnSync(['which', name])
    if (result.exitCode === 0) {
      cachedWhisperPath = result.stdout.toString().trim()
      break
    }
  }
  whisperChecked = true
  return cachedWhisperPath
}

let ffmpegChecked = false
let ffmpegAvailable = false

export async function checkFfmpeg(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegAvailable
  const result = Bun.spawnSync(['which', 'ffmpeg'])
  ffmpegAvailable = result.exitCode === 0
  ffmpegChecked = true
  return ffmpegAvailable
}

let ffprobeChecked = false
let ffprobeAvailable = false

export async function checkFfprobe(): Promise<boolean> {
  if (ffprobeChecked) return ffprobeAvailable
  const result = Bun.spawnSync(['which', 'ffprobe'])
  ffprobeAvailable = result.exitCode === 0
  ffprobeChecked = true
  return ffprobeAvailable
}

/** Reset cached checks (for testing). */
export function resetChecks(): void {
  cachedWhisperPath = null
  whisperChecked = false
  ffmpegChecked = false
  ffmpegAvailable = false
  ffprobeChecked = false
  ffprobeAvailable = false
}

// ── Audio duration ───────────────────────────────────────────────────

/**
 * Get audio duration in seconds via ffprobe.
 * Returns null if ffprobe fails or duration can't be determined.
 */
export async function getAudioDuration(filePath: string): Promise<number | null> {
  const result = Bun.spawnSync([
    'ffprobe', '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ])
  if (result.exitCode !== 0) return null
  const dur = Number(result.stdout.toString().trim())
  return Number.isFinite(dur) ? dur : null
}

// ── Audio conversion ─────────────────────────────────────────────────

/**
 * Convert an audio file to 16kHz mono WAV via ffmpeg.
 * Returns the path to the temp WAV file. Caller must clean up.
 */
export async function convertToWav(filePath: string, logf: LogFn): Promise<string> {
  const wavPath = join(tmpdir(), `dc-stt-${Date.now()}-${basename(filePath, '.m4a')}.wav`)
  const proc = Bun.spawn([
    'ffmpeg', '-y', '-i', filePath,
    '-ar', '16000', '-ac', '1', '-f', 'wav',
    wavPath,
  ], { stdout: 'ignore', stderr: 'pipe' })

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`ffmpeg conversion failed (exit ${exitCode}): ${stderr.slice(0, 200)}`)
  }
  logf('stt: converted %s → %s', filePath, wavPath)
  return wavPath
}

// ── Model download ───────────────────────────────────────────────────

/** Map model name to Hugging Face filename. */
function modelFileName(model: string): string {
  // Model names: tiny, tiny.en, base, base.en, small, small.en, medium, medium.en, large, large-v3
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

// ── Confidence ───────────────────────────────────────────────────────

/**
 * Compute duration-weighted average of segment avg_logprob values.
 * Values closer to 0 = high confidence, more negative = lower confidence.
 * Returns 0 for empty segments (treated as low confidence).
 */
export function computeConfidence(
  segments: Array<{ start: number; end: number; avg_logprob: number }>
): number {
  if (segments.length === 0) return 0
  let totalWeight = 0
  let weightedSum = 0
  for (const seg of segments) {
    const duration = Math.max(seg.end - seg.start, 1)
    totalWeight += duration
    weightedSum += duration * seg.avg_logprob
  }
  return weightedSum / totalWeight
}

// ── Transcription ────────────────────────────────────────────────────

/**
 * Transcribe an audio file using whisper.cpp.
 *
 * Converts to WAV, runs whisper.cpp with --output-json, parses output
 * including per-segment avg_logprob for confidence scoring. Respects
 * timeout — kills the whisper process if it exceeds config.timeoutSec.
 */
export async function transcribe(
  filePath: string,
  config: STTConfig,
  whisperPath: string,
  modelPath: string,
  logf: LogFn,
): Promise<TranscriptionResult> {
  let wavPath: string | null = null
  let jsonPath: string | null = null

  try {
    // 1. Convert .m4a → 16kHz mono .wav
    wavPath = await convertToWav(filePath, logf)

    // 2. Run whisper.cpp with JSON output
    jsonPath = wavPath.replace(/\.wav$/, '.json')
    // whisper.cpp writes <input>.json when --output-json is set
    const expectedJsonPath = wavPath + '.json'

    logf('stt: transcribing %s with model %s (timeout %ds)',
      filePath, config.model, config.timeoutSec)
    const startTime = Date.now()

    const proc = Bun.spawn([
      whisperPath,
      '--model', modelPath,
      '--output-json',
      '--file', wavPath,
    ], { stdout: 'pipe', stderr: 'pipe' })

    // Race transcription against timeout
    const timeoutMs = config.timeoutSec * 1000
    const result = await Promise.race([
      proc.exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ])

    if (result === 'timeout') {
      proc.kill()
      throw new Error(`Transcription timed out after ${config.timeoutSec}s`)
    }

    if (result !== 0) {
      const stderr = await new Response(proc.stderr).text()
      throw new Error(`whisper.cpp failed (exit ${result}): ${stderr.slice(0, 300)}`)
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    logf('stt: whisper completed in %ss', elapsed)

    // 3. Parse JSON output
    // whisper.cpp outputs to <filename>.json (appends .json to input path)
    const actualJsonPath = existsSync(expectedJsonPath)
      ? expectedJsonPath
      : existsSync(jsonPath) ? jsonPath : null

    if (!actualJsonPath) {
      throw new Error(`Whisper JSON output not found (checked ${expectedJsonPath} and ${jsonPath})`)
    }
    jsonPath = actualJsonPath

    const output = JSON.parse(readFileSync(jsonPath, 'utf-8'))

    // whisper.cpp --output-json format: { transcription: [{ timestamps: {from, to}, text, offsets: {from, to} }] }
    // whisper.cpp full JSON format: { result: { language: "en" }, transcription: [...] } with per-segment data
    const rawSegments = output.transcription ?? []
    const segments: TranscriptionSegment[] = rawSegments.map(
      (seg: { offsets?: { from: number; to: number }; text?: string; timestamps?: { from: string; to: string } },
       _i: number) => ({
        start: (seg.offsets?.from ?? 0) / 1000,
        end: (seg.offsets?.to ?? 0) / 1000,
        text: (seg.text ?? '').trim(),
        // whisper.cpp JSON includes avg_logprob at segment level when using --output-json
        avg_logprob: (seg as Record<string, unknown>).avg_logprob as number ?? 0,
      })
    )

    const text = segments.map(s => s.text).join(' ').trim()
    const durationSec = segments.length > 0
      ? segments[segments.length - 1].end
      : 0
    const confidence = computeConfidence(segments)

    return { text, confidence, segments, durationSec }
  } finally {
    // Clean up temp files
    if (wavPath) {
      try { unlinkSync(wavPath) } catch (e) { logf('stt: cleanup wav: %v', e) }
    }
    if (jsonPath) {
      try { unlinkSync(jsonPath) } catch (e) { logf('stt: cleanup json: %v', e) }
    }
    // Also clean up any other whisper output files
    if (wavPath) {
      for (const ext of ['.txt', '.srt', '.vtt', '.csv', '.lrc', '.json']) {
        const f = wavPath + ext
        if (f !== jsonPath && existsSync(f)) {
          try { unlinkSync(f) } catch (e) { logf('stt: cleanup %s: %v', ext, e) }
        }
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Check if a message is a voice message that should be transcribed. */
export function isVoiceMessage(msg: { viewType?: string; file?: string }): boolean {
  return msg.viewType === 'Voice' && !!msg.file
}

/** Minimum audio duration (seconds) to attempt transcription. */
export const MIN_AUDIO_DURATION_SEC = 0.5
