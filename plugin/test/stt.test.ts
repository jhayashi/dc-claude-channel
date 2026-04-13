import { describe, test, expect } from 'bun:test'
import {
  parseSTTConfig,
  computeConfidence,
  isVoiceMessage,
  MIN_AUDIO_DURATION_SEC,
  type STTConfig,
} from '../stt'

describe('parseSTTConfig', () => {
  const base: Record<string, string | undefined> = {}

  test('defaults when no env vars set', () => {
    const cfg = parseSTTConfig(base)
    expect(cfg.enabled).toBe(true)
    expect(cfg.model).toBe('base.en')
    expect(cfg.echo).toBe('quoted')
    expect(cfg.confidenceThreshold).toBe(-1.0)
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

  test('DC_STT_CONFIDENCE sets threshold', () => {
    expect(parseSTTConfig({ DC_STT_CONFIDENCE: '-0.5' }).confidenceThreshold).toBe(-0.5)
    expect(parseSTTConfig({ DC_STT_CONFIDENCE: '-2.0' }).confidenceThreshold).toBe(-2.0)
  })

  test('DC_STT_CONFIDENCE invalid falls back to -1.0', () => {
    expect(parseSTTConfig({ DC_STT_CONFIDENCE: 'abc' }).confidenceThreshold).toBe(-1.0)
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

describe('computeConfidence', () => {
  test('empty segments → 0', () => {
    expect(computeConfidence([])).toBe(0)
  })

  test('single segment returns its avg_logprob', () => {
    const segs = [{ start: 0, end: 5, avg_logprob: -0.3 }]
    expect(computeConfidence(segs)).toBeCloseTo(-0.3, 5)
  })

  test('duration-weighted average across segments', () => {
    // seg1: 2s duration, logprob -0.2 → weight 2, contribution -0.4
    // seg2: 8s duration, logprob -0.5 → weight 8, contribution -4.0
    // total weight 10, weighted sum -4.4, average -0.44
    const segs = [
      { start: 0, end: 2, avg_logprob: -0.2 },
      { start: 2, end: 10, avg_logprob: -0.5 },
    ]
    expect(computeConfidence(segs)).toBeCloseTo(-0.44, 5)
  })

  test('zero-length segment gets minimum 1s weight', () => {
    const segs = [
      { start: 0, end: 0, avg_logprob: -0.1 },
      { start: 0, end: 4, avg_logprob: -0.5 },
    ]
    // seg1: max(0,1)=1 weight, contribution -0.1
    // seg2: 4 weight, contribution -2.0
    // total weight 5, weighted sum -2.1, average -0.42
    expect(computeConfidence(segs)).toBeCloseTo(-0.42, 5)
  })

  test('high confidence is closer to 0', () => {
    const high = computeConfidence([{ start: 0, end: 5, avg_logprob: -0.1 }])
    const low = computeConfidence([{ start: 0, end: 5, avg_logprob: -1.5 }])
    expect(high).toBeGreaterThan(low)
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

describe('MIN_AUDIO_DURATION_SEC', () => {
  test('is 0.5 seconds', () => {
    expect(MIN_AUDIO_DURATION_SEC).toBe(0.5)
  })
})
