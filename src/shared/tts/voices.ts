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
  /** Appended to the preset prompt so each tag gets its own reference clip. */
  energyPrompt: string
  /** Pitch-preserving playback multiplier applied to the chunk (atempo). */
  pacing: number
}

/**
 * Three vocal energies of the SAME narrator. Each tag maps to its own
 * generated reference clip (same preset seed, tag-shaped prompt), so the
 * voice stays one person while the delivery changes. Scripts embed the tag
 * inline — it applies from its position until the next tag or the end.
 */
export const DELIVERY_TAGS: Record<DeliveryTagId, DeliveryTag> = {
  hook: {
    id: 'hook',
    energyPrompt: 'Urgent, firm delivery, grabbing attention from the first word.',
    pacing: 1.04
  },
  tactical: {
    id: 'tactical',
    energyPrompt: 'Calm, authoritative delivery, instructing clearly and precisely.',
    pacing: 1.0
  },
  twist: {
    id: 'twist',
    energyPrompt: 'Slower, darker, close-mic delivery, quiet menace in the final reveal.',
    pacing: 0.92
  }
}

/** Untagged narration: the preset's own energy, no pacing change. */
export const DEFAULT_DELIVERY: DeliveryTag = {
  id: 'tactical',
  energyPrompt: '',
  pacing: 1.0
}

/** Deliberate silence between chunks (ms) — the narration's rhythm section. */
export const NARRATION_GAP_MS = {
  /** Plain sentence break. */
  sentence: 140,
  /** New numbered step or a [tactical] transition. */
  step: 280,
  /** The pre-reveal beat right before a [twist] chunk. */
  twistBeat: 500
} as const
