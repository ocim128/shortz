import type { TtsVoicePreset } from '../../shared/tts/voices'

/**
 * SSML builder for Edge TTS (pure — unit-tested without a socket).
 *
 * The endpoint accepts the standard `speak`/`voice`/`prosody` elements but
 * REJECTS `<break>` (it kills the connection with 1007 — verified live), so
 * dramatic pauses are NOT SSML: the synthesizer emits one request per sentence
 * and stitches the preset's pause between them with ffmpeg silence.
 */

/** XML-escape user text before it enters the SSML document. */
export function escapeSsmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Split narration into sentences. Splits after `.`, `!`, `?`, `…` (followed by
 * whitespace) and on blank lines; Indonesian abbreviations like "dll." can
 * split early — acceptable for narration pacing, not a subtitle timer.
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=[.!?…])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
}

export function buildSsml(text: string, preset: TtsVoicePreset): string {
  const { rate, pitch, volume } = preset.prosody
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="id-ID">` +
    `<voice name="${preset.voice}">` +
    `<prosody rate="${rate}" pitch="${pitch}" volume="${volume}">` +
    `${escapeSsmlText(text)}` +
    `</prosody></voice></speak>`
  )
}
