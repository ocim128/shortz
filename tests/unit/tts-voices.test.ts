import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DELIVERY,
  DEFAULT_VOICE_ID,
  DELIVERY_TAGS,
  findVoicePreset,
  NARRATION_GAP_MS,
  VOICE_PRESETS
} from '../../src/shared/tts/voices'

describe('VoxCPM voice designs', () => {
  it('offers distinct designs without the retired Edge presets', () => {
    expect(VOICE_PRESETS.length).toBeGreaterThanOrEqual(10)
    expect(new Set(VOICE_PRESETS.map((voice) => voice.id)).size).toBe(VOICE_PRESETS.length)
    expect(new Set(VOICE_PRESETS.map((voice) => voice.prompt)).size).toBe(VOICE_PRESETS.length)
    expect(new Set(VOICE_PRESETS.map((voice) => voice.seed)).size).toBe(VOICE_PRESETS.length)
    expect(findVoicePreset('rimba')).toBeUndefined()
    expect(findVoicePreset(DEFAULT_VOICE_ID)).toBeDefined()
  })

  it('prompts never carry tag energies — every chunk shares ONE identity', () => {
    // The per-tag reference experiment drifted accent/timbre; prompts must
    // stay the single, tag-free identity string for the whole episode.
    for (const voice of VOICE_PRESETS) {
      expect(voice.prompt).not.toMatch(/\[(hook|tactical|twist)\]/i)
    }
  })
})

describe('delivery tags (post-processing energies only)', () => {
  it('never speed up speech — timbre distortion is banned', () => {
    for (const tag of Object.values(DELIVERY_TAGS)) {
      expect(tag.pacing).toBeLessThanOrEqual(1.0)
      expect(tag.pacing).toBeGreaterThanOrEqual(0.95) // only subtle slow-downs
    }
    expect(DELIVERY_TAGS.hook.pacing).toBe(1.0)
    expect(DELIVERY_TAGS.tactical.pacing).toBe(1.0)
    expect(DELIVERY_TAGS.twist.pacing).toBeLessThanOrEqual(0.97)
  })

  it('shapes loudness: hook up, twist down', () => {
    expect(DELIVERY_TAGS.hook.levelDb).toBeGreaterThan(0)
    expect(DELIVERY_TAGS.twist.levelDb).toBeLessThan(0)
    expect(DELIVERY_TAGS.tactical.levelDb).toBe(0)
    expect(DEFAULT_DELIVERY.levelDb).toBe(0)
  })

  it('keeps the deliberate gap rhythm in the broadcast band', () => {
    expect(NARRATION_GAP_MS.hook).toBe(100)
    expect(NARRATION_GAP_MS.sentence).toBe(160)
    expect(NARRATION_GAP_MS.step).toBe(260)
    expect(NARRATION_GAP_MS.twistBeat).toBe(450)
  })
})
