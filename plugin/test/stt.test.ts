import { describe, test, expect } from 'bun:test'
import { join } from 'node:path'
import {
  parseSTTConfig,
  isVoiceMessage,
  MIN_AUDIO_DURATION_SEC,
  AudioTooShortError,
  checkAudioDuration,
  ensureModel,
  transcribe,
  _resetSttWorker,
} from '../stt'

describe('parseSTTConfig', () => {
  const base: Record<string, string | undefined> = {}

  test('defaults when no env vars set', () => {
    const cfg = parseSTTConfig(base)
    expect(cfg.enabled).toBe(true)
    expect(cfg.model).toBe('base.en')
    expect(cfg.echo).toBe('quoted')
    expect(cfg.timeoutSec).toBe(120)
    expect(cfg.maxDurationSec).toBe(300)
    expect(cfg.modelDir).toContain('whisper-models')
  })

  test('DC_STT_ENABLED=false disables', () => {
    expect(parseSTTConfig({ DC_STT_ENABLED: 'false' }).enabled).toBe(false)
    expect(parseSTTConfig({ DC_STT_ENABLED: 'False' }).enabled).toBe(false)
    expect(parseSTTConfig({ DC_STT_ENABLED: 'FALSE' }).enabled).toBe(false)
  })

  test('DC_STT_ENABLED=true enables', () => {
    expect(parseSTTConfig({ DC_STT_ENABLED: 'true' }).enabled).toBe(true)
  })

  test('DC_STT_MODEL overrides model', () => {
    expect(parseSTTConfig({ DC_STT_MODEL: 'small.en' }).model).toBe('small.en')
  })

  test('DC_STT_ECHO=silent sets silent mode', () => {
    expect(parseSTTConfig({ DC_STT_ECHO: 'silent' }).echo).toBe('silent')
  })

  test('DC_STT_ECHO invalid falls back to quoted', () => {
    expect(parseSTTConfig({ DC_STT_ECHO: 'garbage' }).echo).toBe('quoted')
  })

  test('DC_STT_TIMEOUT_SEC sets timeout', () => {
    expect(parseSTTConfig({ DC_STT_TIMEOUT_SEC: '60' }).timeoutSec).toBe(60)
  })

  test('DC_STT_TIMEOUT_SEC invalid or zero falls back to 120', () => {
    expect(parseSTTConfig({ DC_STT_TIMEOUT_SEC: '0' }).timeoutSec).toBe(120)
    expect(parseSTTConfig({ DC_STT_TIMEOUT_SEC: '-5' }).timeoutSec).toBe(120)
    expect(parseSTTConfig({ DC_STT_TIMEOUT_SEC: 'nope' }).timeoutSec).toBe(120)
  })

  test('DC_STT_MAX_DURATION_SEC sets max duration', () => {
    expect(parseSTTConfig({ DC_STT_MAX_DURATION_SEC: '600' }).maxDurationSec).toBe(600)
  })

  test('DC_STT_MAX_DURATION_SEC invalid falls back to 300', () => {
    expect(parseSTTConfig({ DC_STT_MAX_DURATION_SEC: '0' }).maxDurationSec).toBe(300)
  })

  test('DC_STATE_DIR sets model directory', () => {
    const cfg = parseSTTConfig({ DC_STATE_DIR: '/tmp/test-state' })
    expect(cfg.modelDir).toBe('/tmp/test-state/whisper-models')
  })
})

describe('isVoiceMessage', () => {
  test('voice message with file → true', () => {
    expect(isVoiceMessage({ viewType: 'Voice', file: '/tmp/voice.m4a' })).toBe(true)
  })

  test('voice message without file → false', () => {
    expect(isVoiceMessage({ viewType: 'Voice' })).toBe(false)
    expect(isVoiceMessage({ viewType: 'Voice', file: '' })).toBe(false)
  })

  test('non-voice message → false', () => {
    expect(isVoiceMessage({ viewType: 'Image', file: '/tmp/photo.jpg' })).toBe(false)
    expect(isVoiceMessage({ viewType: 'Text' })).toBe(false)
    expect(isVoiceMessage({})).toBe(false)
  })
})

describe('MIN_AUDIO_DURATION_SEC enforcement', () => {
  test('checkAudioDuration throws AudioTooShortError for sub-min audio', () => {
    expect(() => checkAudioDuration(0.3)).toThrow(AudioTooShortError)
  })

  test('checkAudioDuration accepts audio at the minimum', () => {
    expect(() => checkAudioDuration(0.5)).not.toThrow()
    expect(() => checkAudioDuration(1.0)).not.toThrow()
  })

  test('MIN_AUDIO_DURATION_SEC is 0.5', () => {
    expect(MIN_AUDIO_DURATION_SEC).toBe(0.5)
  })
})

describe('_resetSttWorker', () => {
  test('is idempotent and safe to call with no worker', () => {
    expect(() => _resetSttWorker()).not.toThrow()
    expect(() => _resetSttWorker()).not.toThrow()  // second call
  })
})

describe('transcribe does not block the event loop', () => {
  test('setTimeout callbacks fire during a transcription', async () => {
    if (process.env.DC_STT_INTEGRATION_TEST !== '1') return
    const fixturePath = join(import.meta.dir, 'fixtures', 'hello.wav')
    const config = parseSTTConfig({})
    const modelPath = await ensureModel(config, () => {})

    let tickCount = 0
    const ticker = setInterval(() => { tickCount++ }, 50)
    try {
      await transcribe(fixturePath, config, modelPath, () => {})
    } finally {
      clearInterval(ticker)
      _resetSttWorker()
    }
    // If the event loop was blocked the entire run, tickCount would be 0 or 1.
    // A real Worker-based transcribe should yield many ticks.
    expect(tickCount).toBeGreaterThan(3)
  }, 30_000)
})
