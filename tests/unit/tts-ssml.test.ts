import { describe, expect, it } from 'vitest'
import { buildSsml, escapeSsmlText, splitSentences } from '../../src/core/tts/ssml'
import { findVoicePreset, VOICE_PRESETS } from '../../src/shared/tts/legacy-edge-voices'

describe('escapeSsmlText', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeSsmlText('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f'
    )
  })
})

describe('splitSentences', () => {
  it('splits on terminal punctuation', () => {
    expect(splitSentences('Hujan turun. Angin kencang! Aku bertahan.')).toEqual([
      'Hujan turun.',
      'Angin kencang!',
      'Aku bertahan.'
    ])
  })

  it('splits on ellipsis and blank lines', () => {
    expect(splitSentences('Dua hari… tanpa air.\n\nLalu hujan turun.')).toEqual([
      'Dua hari…',
      'tanpa air.',
      'Lalu hujan turun.'
    ])
  })

  it('collapses inner whitespace and drops empties', () => {
    expect(splitSentences('  Satu   kalimat.  \n\n\n  ')).toEqual(['Satu kalimat.'])
  })
})

describe('buildSsml', () => {
  it('wraps the text in voice + prosody with the preset values', () => {
    const preset = findVoicePreset('rimba')!
    const ssml = buildSsml('Malam pertama di rimba.', preset)
    expect(ssml).toContain('<voice name="id-ID-ArdiNeural">')
    expect(ssml).toContain(
      `<prosody rate="${preset.prosody.rate}" pitch="${preset.prosody.pitch}" volume="${preset.prosody.volume}">`
    )
    expect(ssml.startsWith('<speak version="1.0"')).toBe(true)
    expect(ssml.endsWith('</prosody></voice></speak>'))
  })

  it('never emits break elements — the endpoint rejects them (1007); pauses are ffmpeg silence', () => {
    for (const preset of VOICE_PRESETS) {
      expect(buildSsml('Satu. Dua. Tiga.', preset)).not.toContain('<break')
    }
  })

  it('escapes user text so markup cannot escape the prosody element', () => {
    const ssml = buildSsml('Harga <berkurang> & "diskon".', findVoicePreset('rimba')!)
    expect(ssml).toContain('&lt;berkurang&gt;')
    expect(ssml).toContain('&amp;')
    expect(ssml).toContain('&quot;')
    expect(ssml).not.toContain('<berkurang>')
  })

  it('carries every preset prosody into the document', () => {
    for (const preset of VOICE_PRESETS) {
      const ssml = buildSsml('Satu.', preset)
      expect(ssml).toContain(`rate="${preset.prosody.rate}"`)
      expect(ssml).toContain(`pitch="${preset.prosody.pitch}"`)
      expect(ssml).toContain(`volume="${preset.prosody.volume}"`)
    }
  })
})
