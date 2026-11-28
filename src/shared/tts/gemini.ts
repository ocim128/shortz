/** Designed voices are scoped to the project that created them. */
export const INVESTIGATOR_VOICE_ID = 'voice_71a5a701-796e-421d-840e-0adc00b0816a'
export const ARCHIPELAGO_VOICE_ID = 'voice_6eca01c6-096f-4dcc-844b-bf11ebd10b55'
export const ARCHIPELAGO_VOICE_ALIAS = 'archipelago'
export const ARCHIPELAGO_EN_VOICE_ID = 'voice_22553e13-388a-44ac-94a4-306a4833db3a'
export const ARCHIPELAGO_EN_VOICE_ALIAS = 'archipelago-en'
export const DEFAULT_GEMINI_TTS_VOICE = 'voice_486ejtx78ywn'
export const GEMINI_TTS_VOICES = ['Charon', 'Fenrir', 'Orus', 'Algenib'] as const

export const INVESTIGATOR_VOICE = {
  id: INVESTIGATOR_VOICE_ID,
  name: 'Investigator',
  description: 'Custom Indonesian narrator with a clear, measured and curious delivery · Gemini 3.8 Cloud',
  languageCode: 'id-ID',
  asrLanguage: 'id'
} as const

export const ARCHIPELAGO_VOICE = {
  id: ARCHIPELAGO_VOICE_ID,
  name: 'Archipelago',
  description: 'Custom Indonesian documentary narrator with an intimate, thoughtful and curious voice · Gemini 3.8 Cloud',
  languageCode: 'id-ID',
  asrLanguage: 'id'
} as const

export const ARCHIPELAGO_EN_VOICE = {
  id: ARCHIPELAGO_EN_VOICE_ID,
  name: 'Archipelago (EN)',
  description: 'Custom English documentary narrator with a warm archival baritone and expressive dynamics · Gemini 3.8 Cloud',
  languageCode: 'en-US',
  asrLanguage: 'en'
} as const

export function geminiVoiceLanguage(voiceId: string): { languageCode: string; asrLanguage: string } {
  if (voiceId === ARCHIPELAGO_EN_VOICE_ID) {
    return { languageCode: ARCHIPELAGO_EN_VOICE.languageCode, asrLanguage: ARCHIPELAGO_EN_VOICE.asrLanguage }
  }
  return { languageCode: 'id-ID', asrLanguage: 'id' }
}
