import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOICE_ID,
  findVoicePreset,
  PREVIEW_TEXT,
  TTS_MAX_TEXT_LENGTH,
  VOICE_PRESETS
} from '../../src/shared/tts/voices'

describe('tts voice registry', () => {
  it('ships at least five selectable voices', () => {
    expect(VOICE_PRESETS.length).toBeGreaterThanOrEqual(5)
  })

  it('has unique ids and valid shapes', () => {
    const ids = VOICE_PRESETS.map((v) => v.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const v of VOICE_PRESETS) {
      expect(v.id).toMatch(/^[a-z-]+$/)
      expect(v.name.length).toBeGreaterThan(0)
      expect(v.description.length).toBeGreaterThan(0)
      // The requirement: male, masculine, mature, Indonesian — one base voice.
      expect(v.voice).toBe('id-ID-ArdiNeural')
      expect(v.prosody.rate).toMatch(/^[+-]\d+%$/)
      expect(v.prosody.pitch).toMatch(/^[+-]\d+Hz$/)
      expect(v.prosody.volume).toMatch(/^[+-]\d+%$/)
      expect(v.sentenceBreakMs).toBeGreaterThanOrEqual(100)
      expect(v.sentenceBreakMs).toBeLessThanOrEqual(2000)
    }
  })

  it('resolves the default voice and rejects unknown ids', () => {
    expect(findVoicePreset(DEFAULT_VOICE_ID)?.voice).toBe('id-ID-ArdiNeural')
    expect(findVoicePreset('tidak-ada')).toBeUndefined()
  })

  it('keeps presets audibly distinct — no two identical prosody+pause combos', () => {
    const keys = VOICE_PRESETS.map(
      (v) => `${v.prosody.rate}|${v.prosody.pitch}|${v.prosody.volume}|${v.sentenceBreakMs}`
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('ships a multi-sentence preview so pacing is audible', () => {
    expect(PREVIEW_TEXT).toMatch(/[.!?]/)
    expect(PREVIEW_TEXT.split(/[.!?]/).filter((s) => s.trim()).length).toBeGreaterThanOrEqual(3)
  })

  it('caps text at a sane guard rail', () => {
    expect(TTS_MAX_TEXT_LENGTH).toBeGreaterThanOrEqual(1000)
  })
})
