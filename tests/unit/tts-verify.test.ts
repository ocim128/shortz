import { describe, expect, it } from 'vitest'
import type { AsrResult } from '../../src/core/tts/asr'
import {
  CHAR_ACCEPT,
  checkAttempt,
  normalizeForAsr,
  similarity,
  summarizeVerification,
  WORD_ACCEPT,
  wordSequenceRatio
} from '../../src/core/tts/verify'

function asr(transcript: string, words: Array<[string, number, number]>, durationSec: number): AsrResult {
  return {
    transcript,
    words: words.map(([word, start, end]) => ({ word, start, end })),
    durationSec
  }
}

describe('normalizeForAsr', () => {
  it('lowercases, drops punctuation, and speaks % as persen', () => {
    expect(normalizeForAsr('Baterai tinggal 60%, tapi sinyal ada.')).toBe(
      'baterai tinggal 60 persen tapi sinyal ada'
    )
  })

  it('folds Indonesian number words to digits so 60 ≡ enam puluh', () => {
    expect(normalizeForAsr('baterai enam puluh persen')).toBe('baterai 60 persen')
    expect(normalizeForAsr('pukul tiga pagi')).toBe('pukul 3 pagi')
    expect(normalizeForAsr('enam puluh dua persen')).toBe('62 persen')
    expect(normalizeForAsr('pukul 3 pagi')).toBe(normalizeForAsr('pukul tiga pagi'))
  })

  it('strips delivery tags before comparing', () => {
    expect(normalizeForAsr('[hook]Kalau kaca dikut!')).toBe('kalau kaca dikut')
  })
})

describe('similarity (char-level, ranking signal)', () => {
  it('is 1 for identical text and 0 for disjoint text', () => {
    expect(similarity('kamu meraih gagang pintu', 'kamu meraih gagang pintu')).toBe(1)
    expect(similarity('aaaa', 'bbbb')).toBe(0)
  })

  it('sits above the accept line for minor ASR spelling drift', () => {
    // Observed live: whisper-base spelling noise on good audio.
    expect(similarity('pertama kunci semua pintu', 'pertama kunci semua bintu')).toBeGreaterThan(
      CHAR_ACCEPT
    )
  })
})

describe('wordSequenceRatio (the primary gate)', () => {
  it('is 1 for the exact normalized sequence, numbers included', () => {
    expect(wordSequenceRatio('Baterai enam puluh persen.', 'baterai 60 persen')).toBe(1)
  })

  it('drops when a word is substituted (air -> er)', () => {
    const ratio = wordSequenceRatio('air hanya setengah botol', 'er hanya setengah botol')
    expect(ratio).toBeLessThan(WORD_ACCEPT) // 0.75 — retry
  })

  it('drops when a word is dropped or hallucinated', () => {
    expect(wordSequenceRatio('kamu meraih gagang pintu', 'kamu meraih pintu')).toBeLessThan(WORD_ACCEPT)
    expect(wordSequenceRatio('hujan turun', 'hujan turun sekali banget')).toBeLessThan(WORD_ACCEPT)
  })
})

describe('checkAttempt', () => {
  const expected = 'Kamu meraih gagang pintu.' // 4 words
  const words: Array<[string, number, number]> = [
    ['Kamu', 0.1, 0.3],
    ['meraih', 0.3, 0.7],
    ['gagang', 0.7, 1.1],
    ['pintu.', 1.1, 1.6]
  ]

  it('passes a clean take at narration pace', () => {
    // 4 words in 1.7s ≈ 141 wpm — inside the window.
    const attempt = checkAttempt({ expected, seed: 707, asr: asr('Kamu meraih gagang pintu.', words, 1.7) })
    expect(attempt.passed).toBe(true)
    expect(attempt.reasons).toEqual([])
  })

  it('rejects a hallucinated transcript', () => {
    const attempt = checkAttempt({
      expected,
      seed: 1,
      asr: asr('Kamu meraih er gagang pintu kok banget sekali.', words, 1.7)
    })
    expect(attempt.passed).toBe(false)
    expect(attempt.reasons.join(' ')).toContain('word mismatch')
  })

  it('rejects abnormally fast output (>25% above target WPM)', () => {
    // 4 words in 0.6s ≈ 400 wpm — runaway speed the model has produced.
    const attempt = checkAttempt({ expected, seed: 1, asr: asr('Kamu meraih gagang pintu.', words, 0.6) })
    expect(attempt.durationOk).toBe(false)
    expect(attempt.passed).toBe(false)
  })

  it('rejects abnormally slow output', () => {
    // 4 words in 12s ≈ 20 wpm.
    const attempt = checkAttempt({ expected, seed: 1, asr: asr('Kamu meraih gagang pintu.', words, 12) })
    expect(attempt.durationOk).toBe(false)
  })

  it('treats a 0ms onset as a WARNING, not a rejection (whisper floors word starts)', () => {
    // Observed live: perfect transcripts whose first word reports start=0.0.
    const clipped: Array<[string, number, number]> = [
      ['Kamu', 0.0, 0.3],
      ['meraih', 0.3, 0.7],
      ['gagang', 0.7, 1.1],
      ['pintu.', 1.1, 1.6]
    ]
    const attempt = checkAttempt({ expected, seed: 1, asr: asr('Kamu meraih gagang pintu.', clipped, 1.7) })
    expect(attempt.leadClip).toBe(true)
    expect(attempt.passed).toBe(true)
    expect(attempt.warnings.join(' ')).toContain('clipped')
  })

  it('still rejects a leading stutter outright', () => {
    const attempt = checkAttempt({
      expected: 'Pertama, kunci pintu.',
      seed: 1,
      asr: asr('Per pertama kunci pintu.', [
        ['Per', 0.1, 0.2],
        ['pertama', 0.2, 0.7],
        ['kunci', 0.7, 1.0],
        ['pintu.', 1.0, 1.4]
      ], 1.5)
    })
    expect(attempt.stutter).toBe(true)
    expect(attempt.passed).toBe(false)
    expect(attempt.reasons.join(' ')).toContain('stutter')
  })
})

describe('summarizeVerification', () => {
  const good = checkAttempt({
    expected: 'Hujan turun.',
    seed: 100,
    asr: asr('Hujan turun.', [['Hujan', 0.1, 0.5], ['turun.', 0.5, 0.9]], 0.9)
  })

  it('records zero retries when the first take passes', () => {
    const summary = summarizeVerification([good])
    expect(summary.status).toBe('verified')
    expect(summary.retries).toBe(0)
    expect(summary.accepted).toBe(0)
  })

  it('stops counting once verified, but keeps every attempt in the record', () => {
    const badTake = checkAttempt({
      expected: 'Hujan turun.',
      seed: 201,
      asr: asr('Hujan turun sekali.', [['Hujan', 0.1, 0.5], ['turun', 0.5, 0.8], ['sekali.', 0.8, 1.1]], 1.4)
    })
    expect(badTake.passed).toBe(false) // hallucinated "sekali"
    const summary = summarizeVerification([badTake, good])
    expect(summary.status).toBe('verified')
    expect(summary.retries).toBe(1)
    expect(summary.attempts).toHaveLength(2)
    expect(summary.accepted).toBe(1)
  })

  it('fails the chunk when the best of three stays under the word floor', () => {
    const weak = checkAttempt({
      expected: 'Kamu meraih gagang pintu.',
      seed: 1,
      asr: asr('er er er er', [['er', 0.2, 0.6]], 3.0)
    })
    expect(weak.wordRatio).toBeLessThan(0.75)
    const summary = summarizeVerification([weak, weak, weak])
    expect(summary.status).toBe('failed')
    expect(summary.retries).toBe(2)
  })

  it('whisper tokenization drift ("di samping" ↔ "disamping") now passes via merge', () => {
    const expected = 'Kalau langkah berhenti di samping pintu, biarkan bayangannya lewat dulu.'
    const attempt = checkAttempt({
      expected,
      seed: 1,
      asr: asr(
        'Kalau langkah berhenti disamping pintu biarkan bayangannya lewat dulu.',
        expected.replace('di samping', 'disamping').split(' ').map<[string, number, number]>((word, i) => [word, 0.1 + i * 0.4, 0.1 + i * 0.4 + 0.35]),
        5.0
      )
    })
    expect(attempt.passed).toBe(true)
    expect(attempt.wordRatio).toBe(1)
  })

  it('keeps the best take with a warning when a mishearing survives all retries', () => {
    // Live-observed shape: whisper consistently misspells two words of a long
    // chunk ("diketuk"→"diketu", "menoleh"→"menolih") — below the word gate but
    // char 0.97 (audio is right) → ships flagged, not failed.
    const expected = 'Kalau kaca diketuk jangan langsung menoleh, perlahan saja cek spionasemu.'
    const middling = checkAttempt({
      expected,
      seed: 1,
      asr: asr(
        'Kalau kaca diketu jangan langsung menolih, perlahan saja cek spionasemu.',
        ['Kalau', 'kaca', 'diketuk', 'jangan', 'langsung', 'menoleh,', 'perlahan', 'saja', 'cek', 'spionasemu.'].map<[string, number, number]>((word, i) => [word, 0.1 + i * 0.5, 0.1 + i * 0.5 + 0.45]),
        5.1
      )
    })
    expect(middling.passed).toBe(false)
    expect(middling.wordRatio).toBeGreaterThanOrEqual(0.75)
    expect(middling.wordRatio).toBeLessThan(0.9)
    expect(middling.similarity).toBeGreaterThanOrEqual(0.88)
    const summary = summarizeVerification([middling, middling, middling])
    expect(summary.status).toBe('accepted-with-warnings')
  })

  it('prefers a fully passing take over a higher-similarity failing one', () => {
    const highButFlawed = checkAttempt({
      expected: 'Hujan turun.',
      seed: 1,
      asr: asr('Hujan turun sekali.', [['Hujan', 0.1, 0.5], ['turun', 0.5, 0.8], ['sekali.', 0.8, 1.0]], 1.0)
    })
    const summary = summarizeVerification([highButFlawed, good])
    expect(summary.status).toBe('verified')
    expect(summary.accepted).toBe(1)
  })
})
