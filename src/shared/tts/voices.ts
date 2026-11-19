/** Voice designs for VoxCPM2. These describe generated voices, not actors. */
export interface TtsVoicePreset {
  id: string
  name: string
  description: string
  prompt: string
  seed: number
}

const BASE = 'Native Indonesian man in his forties, masculine voice, natural Indonesian accent, telling a survival experience.'

export const VOICE_PRESETS: readonly TtsVoicePreset[] = [
  { id: 'penjelajah', name: 'Penjelajah', description: 'Deep, grounded explorer; measured and quietly tense', prompt: `${BASE} Deep resonant voice, measured pace, calm but quietly tense.`, seed: 101 },
  { id: 'penyintas', name: 'Penyintas', description: 'Weathered survivor recalling a frightening journey', prompt: `${BASE} Low, slightly rough voice, reflective, intimate and serious.`, seed: 202 },
  { id: 'pemandu', name: 'Pemandu', description: 'Steady wilderness guide with a reassuring presence', prompt: `${BASE} Warm low voice, clear and confident, steady and reassuring.`, seed: 303 },
  { id: 'pemburu', name: 'Pemburu', description: 'Gravelly and alert, with restrained suspense', prompt: `${BASE} Gravelly baritone, alert and suspenseful, restrained intensity.`, seed: 404 },
  { id: 'pelaut', name: 'Pelaut', description: 'Seasoned sailor, rugged and contemplative', prompt: `${BASE} Rugged mature voice, thoughtful and restrained, slow deliberate storytelling.`, seed: 505 },
  { id: 'pendaki', name: 'Pendaki', description: 'Experienced climber, composed under pressure', prompt: `${BASE} Firm mid-low voice, composed under pressure, deliberate and vivid.`, seed: 606 },
  { id: 'jejak', name: 'Jejak', description: 'Close, understated narration with a mysterious edge', prompt: `${BASE} Low soft voice, intimate delivery, subtle mystery and tension.`, seed: 707 },
  { id: 'waspada', name: 'Waspada', description: 'Urgent and focused as danger approaches', prompt: `${BASE} Masculine mid-low voice, focused and urgent, quick but clear.`, seed: 808 },
  { id: 'pengembara', name: 'Pengembara', description: 'Warm, reflective traveller telling a hard-won story', prompt: `${BASE} Warm resonant baritone, reflective, personal and unhurried.`, seed: 909 },
  { id: 'penjaga', name: 'Penjaga', description: 'Deep, authoritative voice with controlled intensity', prompt: `${BASE} Deep authoritative voice, controlled intensity, serious and deliberate.`, seed: 1001 },
  { id: 'senja', name: 'Senja', description: 'Tired, quiet voice looking back after the ordeal', prompt: `${BASE} Low tired voice, quiet and emotional, reflective with a sense of relief.`, seed: 1102 },
  { id: 'petir', name: 'Petir', description: 'Powerful, dramatic narration for the climactic moment', prompt: `${BASE} Powerful baritone, dramatic and urgent, rising tension without shouting.`, seed: 1203 }
]

export const DEFAULT_VOICE_ID = 'penjelajah'
export function findVoicePreset(id: string): TtsVoicePreset | undefined {
  return VOICE_PRESETS.find((v) => v.id === id)
}

export const PREVIEW_TEXT = 'Malam itu, hujan turun tanpa henti. Persediaan kami hampir habis. Saat suara itu terdengar dari balik pepohonan, aku sadar kami tidak sendirian.'
export const TTS_MAX_TEXT_LENGTH = 10_000

// --- inline delivery tags (Dimensi-Niskala narration energies) ----------------

export type DeliveryTagId = 'hook' | 'tactical' | 'twist'

export interface DeliveryTag {
  id: DeliveryTagId
  /**
   * Pitch-preserving playback multiplier. ≤1.0 only — speed-ups read as
   * robotic timbre shifts between chunks, so the hook gets its urgency from
   * level and gap timing instead.
   */
  pacing: number
  /** Chunk loudness shaping (dB), applied per chunk before the master. */
  levelDb: number
}

/**
 * Delivery energies applied purely in post (level + pacing + gaps). Chunks
 * all condition on the ONE reference clip with the ONE prompt, so speaker
 * identity and Indonesian accent cannot drift between chunks.
 *
 * The hook↔twist contrast spans 4.5 dB on purpose: a consistent single-voice
 * TTS narrator caps the program's loudness range near 4 LU otherwise, and the
 * broadcast target is LRA 5–7 (the urgent-punch vs quiet-reveal contrast IS
 * the dynamics). +0.5/−1.5 dB was tried live and measured LRA 2.6.
 */
export const DELIVERY_TAGS: Record<DeliveryTagId, DeliveryTag> = {
  hook: { id: 'hook', pacing: 1.0, levelDb: 1.5 },
  tactical: { id: 'tactical', pacing: 1.0, levelDb: 0 },
  twist: { id: 'twist', pacing: 0.97, levelDb: -3 }
}

/** Untagged narration: the preset's own delivery, no shaping. */
export const DEFAULT_DELIVERY: DeliveryTag = {
  id: 'tactical',
  pacing: 1.0,
  levelDb: 0
}

/** Deliberate silence between chunks (ms) — the narration's rhythm section. */
export const NARRATION_GAP_MS = {
  /** Tight hook pacing. */
  hook: 100,
  /** Plain sentence break. */
  sentence: 160,
  /** New numbered step or a [tactical] transition. */
  step: 260,
  /** The pre-reveal beat right before a [twist] chunk. */
  twistBeat: 450
} as const
