/**
 * TTS voice presets (docs/technical/project-structure.md §"IPC contract" —
 * shared shapes live in src/shared so the renderer and the core read one
 * registry).
 *
 * Edge TTS ships exactly one male Indonesian neural voice
 * (`id-ID-ArdiNeural` — mature, masculine). The five selectable "voices" are
 * prosody presets on that base: rate/pitch/volume plus a dramatic pause
 * after every sentence, each tuned to a survival-storytelling register.
 */

export interface TtsVoicePreset {
  id: string
  /** Display name (Indonesian, survival-themed). */
  name: string
  /** English character description shown under the name in the picker. */
  description: string
  /** Edge TTS voice name — fixed for every preset. */
  voice: 'id-ID-ArdiNeural'
  /** SSML prosody values, e.g. rate '-10%', pitch '-8Hz', volume '+0%'. */
  prosody: { rate: string; pitch: string; volume: string }
  /** Dramatic pause inserted after each sentence, in ms. */
  sentenceBreakMs: number
}

export const TTS_BASE_VOICE = 'id-ID-ArdiNeural' as const

export const VOICE_PRESETS: readonly TtsVoicePreset[] = [
  {
    id: 'rimba',
    name: 'Rimba',
    description: 'Deep, deliberate jungle narrator — the default storytelling voice',
    voice: TTS_BASE_VOICE,
    prosody: { rate: '-10%', pitch: '-8Hz', volume: '+0%' },
    sentenceBreakMs: 650
  },
  {
    id: 'api-unggun',
    name: 'Api Unggun',
    description: 'Slow, reflective campfire telling — long pauses, extra deep',
    voice: TTS_BASE_VOICE,
    prosody: { rate: '-20%', pitch: '-12Hz', volume: '+0%' },
    sentenceBreakMs: 900
  },
  {
    id: 'detak',
    name: 'Detak',
    description: 'Tense, urgent pacing — like a heartbeat before danger',
    voice: TTS_BASE_VOICE,
    prosody: { rate: '+6%', pitch: '+3Hz', volume: '+0%' },
    sentenceBreakMs: 350
  },
  {
    id: 'badai',
    name: 'Badai',
    description: 'Intense storm energy — loud and fast, peak drama',
    voice: TTS_BASE_VOICE,
    prosody: { rate: '+14%', pitch: '+8Hz', volume: '+15%' },
    sentenceBreakMs: 250
  },
  {
    id: 'fajar',
    name: 'Fajar',
    description: 'Calm, exhausted dawn aftermath — quiet relief',
    voice: TTS_BASE_VOICE,
    prosody: { rate: '-5%', pitch: '-4Hz', volume: '+0%' },
    sentenceBreakMs: 500
  }
]

export const DEFAULT_VOICE_ID = 'rimba'

export function findVoicePreset(id: string): TtsVoicePreset | undefined {
  return VOICE_PRESETS.find((v) => v.id === id)
}

/** Fixed sample the voice picker plays — three sentences so the preset's
 * pacing/pauses are audible. Same register as the target content. */
export const PREVIEW_TEXT =
  'Dua hari tanpa air, tanpa makan. Tapi aku masih bernapas. ' +
  'Dan selama masih bernapas, aku akan terus berjalan.'

/** Char cap for one synthesis — enforced by the core, shown by the screen. */
export const TTS_MAX_TEXT_LENGTH = 10_000
