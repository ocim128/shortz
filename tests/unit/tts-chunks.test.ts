import { describe, expect, it } from 'vitest'
import {
  CHUNK_CHAR_LIMIT,
  splitIntoChunks,
  splitLongSentence,
  startsNumberedStep,
  stripDeliveryTags
} from '../../src/core/tts/chunks'

describe('stripDeliveryTags', () => {
  it('removes tags and collapses whitespace, keeping the words', () => {
    expect(stripDeliveryTags('[hook]Kalau kaca dikut. [tactical]Pertama, kunci pintu.'))
      .toBe('Kalau kaca dikut. Pertama, kunci pintu.')
  })

  it('is a no-op for untagged scripts', () => {
    expect(stripDeliveryTags('Hujan turun.')).toBe('Hujan turun.')
  })

  it('preserves paragraph breaks after tags', () => {
    expect(stripDeliveryTags('Satu. [hook]\n\nDua.')).toBe('Satu. \n\nDua.')
    expect(splitIntoChunks('Satu. [hook]\n\nDua.').map((c) => c.text)).toEqual(['Satu.', 'Dua.'])
  })
})

describe('splitIntoChunks — tags', () => {
  it('assigns each chunk the tag active at its position', () => {
    const chunks = splitIntoChunks(
      '[hook]Kalau kaca dikut, jangan buka. Tahan napas.\n\n[tactical]Pertama, kunci semua pintu.'
    )
    // Adjacent short sentences under one tag batch into a single generation.
    expect(chunks.map((c) => c.tag)).toEqual(['hook', 'tactical'])
    expect(chunks[0]?.text).toBe('Kalau kaca dikut, jangan buka. Tahan napas.')
    expect(chunks[1]?.text).toBe('Pertama, kunci semua pintu.')
  })

  it('a tag mid-paragraph starts a new chunk group', () => {
    const chunks = splitIntoChunks('Ayat pertama biasa. [twist]Lalu sunyi.')
    expect(chunks.map((c) => c.tag)).toEqual([null, 'twist'])
    expect(chunks[1]?.text).toBe('Lalu sunyi.')
  })

  it('a tag persists across paragraphs until the next tag', () => {
    const chunks = splitIntoChunks('[tactical]Pertama, kunci.\n\nKedua, diam.')
    expect(chunks.map((c) => c.tag)).toEqual(['tactical', 'tactical'])
  })

  it('untagged narration carries null', () => {
    expect(splitIntoChunks('Satu kalimat.')[0]?.tag).toBeNull()
  })
})

describe('splitIntoChunks — structure', () => {
  it('batches short sentences while they fit the limit', () => {
    const text = 'Hujan turun sepanjang malam. Air merendah pinggul. Aku bertahan.'
    expect(splitIntoChunks(text)).toEqual([
      { index: 0, text, tag: null }
    ])
  })

  it('paragraph breaks always start a new chunk (deliberate beats)', () => {
    const chunks = splitIntoChunks('Langkah kaki mendekat.\n\nSeseorang berhenti.')
    expect(chunks.map((c) => c.text)).toEqual(['Langkah kaki mendekat.', 'Seseorang berhenti.'])
  })

  it('never loses characters: joining chunk texts reconstructs the script', () => {
    const script = (
      '[hook]Di luar pintu mobilmu, ada zombie. ' +
      '[tactical]Pertama, kunci semua pintu dan jangan keluar apapun yang terjadi, karena mereka melihat gerakan. ' +
      'Kedua, matikan mesin.\n\n[twist]Yang mengetuk duduk di belakangmu.'
    )
    const stripped = stripDeliveryTags(script).replace(/\s+/g, ' ').trim()
    const joined = splitIntoChunks(script).map((c) => c.text).join(' ')
    expect(joined).toBe(stripped)
  })

  it('respects the model char limit on every chunk', () => {
    const long = 'Aku berjalan menembus hutan yang gelap, lalu hujan turun tanpa henti sepanjang malam itu. '.repeat(8)
    for (const chunk of splitIntoChunks(long)) {
      expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_CHAR_LIMIT)
    }
  })
})

describe('splitLongSentence — clause safety', () => {
  it('splits at commas, never mid-word', () => {
    const sentence =
      'Pertama kamu harus mengunci semua pintu mobil dengan cepat dan tenang, karena setiap gerakan kecil akan terlihat dari luar jendela.'
    const parts = splitLongSentence(sentence, 80)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(80)
      // Clause pieces end at a word edge, keeping their boundary punctuation.
      expect(part).toMatch(/[a-z.,]$/i)
    }
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(sentence)
  })

  it('splits before a conjunction when no comma is reachable', () => {
    const sentence =
      'Kamu menahan napas ketika langkah kaki itu berhenti tepat di samping mobilmu dan bayangannya perlahan menutupi seluruh jendela kaca.'
    const parts = splitLongSentence(sentence, 60)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 60)).toBe(true)
  })

  it('hard-splits an absurd word without losing characters', () => {
    const word = 'a'.repeat(300)
    const parts = splitLongSentence(word, 120)
    expect(parts.join('')).toBe(word)
    expect(parts.every((p) => p.length <= 120)).toBe(true)
  })

  it('does not include punctuation just beyond the limit', () => {
    const parts = splitLongSentence('abcdefghij, next', 10)
    expect(parts.every((p) => p.length <= 10)).toBe(true)
    expect(parts.join('')).toBe('abcdefghij, next')
  })
})

describe('startsNumberedStep', () => {
  it('detects Indonesian ordinals with or without a comma', () => {
    expect(startsNumberedStep('Pertama, kunci semua pintu.')).toBe(true)
    expect(startsNumberedStep('Kedua hilangkan tanda')).toBe(true)
    expect(startsNumberedStep('ketiga, matikan mesin')).toBe(true)
    expect(startsNumberedStep('1. Kunci pintu')).toBe(true)
  })

  it('ignores words that merely start with the same letters', () => {
    expect(startsNumberedStep('Pertamakah kamu yakin?')).toBe(false)
    expect(startsNumberedStep('Kemudian dia pergi.')).toBe(false)
    expect(startsNumberedStep('Hujan turun.')).toBe(false)
  })
})
