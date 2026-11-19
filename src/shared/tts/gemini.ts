/** Designed voices are scoped to the project that created them. */
export const INVESTIGATOR_VOICE_ID = 'voice_71a5a701-796e-421d-840e-0adc00b0816a'
export const DEFAULT_GEMINI_TTS_VOICE = 'voice_486ejtx78ywn'
export const GEMINI_TTS_VOICES = ['Charon', 'Fenrir', 'Orus', 'Algenib'] as const

export const INVESTIGATOR_VOICE = {
  id: INVESTIGATOR_VOICE_ID,
  name: 'Investigator',
  description: 'Custom Indonesian narrator with a clear, measured and curious delivery · Gemini 3.8 Cloud'
} as const
