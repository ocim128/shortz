import { describe, expect, it } from 'vitest'
import { DEFAULT_VOICE_ID, findVoicePreset, VOICE_PRESETS } from '../../src/shared/tts/voices'

describe('VoxCPM voice designs', () => {
  it('offers distinct designs without the retired Edge presets', () => {
    expect(VOICE_PRESETS.length).toBeGreaterThanOrEqual(10)
    expect(new Set(VOICE_PRESETS.map((voice) => voice.id)).size).toBe(VOICE_PRESETS.length)
    expect(new Set(VOICE_PRESETS.map((voice) => voice.prompt)).size).toBe(VOICE_PRESETS.length)
    expect(new Set(VOICE_PRESETS.map((voice) => voice.seed)).size).toBe(VOICE_PRESETS.length)
    expect(findVoicePreset('rimba')).toBeUndefined()
    expect(findVoicePreset(DEFAULT_VOICE_ID)).toBeDefined()
  })
})
