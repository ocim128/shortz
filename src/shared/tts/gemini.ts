/** The selected designed voice belongs to the first configured Google project. */
export const INVESTIGATOR_VOICE_ID = 'voice_486ejtx78ywn'
export const DEFAULT_GEMINI_TTS_VOICE = INVESTIGATOR_VOICE_ID
export const GEMINI_TTS_VOICES = ['Charon', 'Fenrir', 'Orus', 'Algenib'] as const

export const INVESTIGATOR_VOICE = {
  id: INVESTIGATOR_VOICE_ID,
  name: 'Investigator',
  description: 'Custom Indonesian narrator with a clear, measured and curious delivery · Gemini'
} as const
