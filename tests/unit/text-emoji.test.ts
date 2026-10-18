import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { findSystemEmojiFont } from '../../src/core/render/fonts'
import {
  measureAdvance,
  setEmojiFont,
  splitRunsByCoverage,
  type FontKey
} from '../../src/shared/layout/text'
import { loadFont } from '../helpers/env'

const KEY: FontKey = 'inter-600'

describe('splitRunsByCoverage', () => {
  // Stands in for a real font's cmap: letters and spaces covered, rest not.
  const latin = (ch: string) => /[A-Za-z ]/.test(ch)

  it('keeps astral characters whole and groups maximal runs', () => {
    const runs = splitRunsByCoverage('A 🍁 B 🤖!', latin)
    expect(runs).toEqual([
      { text: 'A ', fallback: false },
      { text: '🍁', fallback: true },
      { text: ' B ', fallback: false },
      { text: '🤖!', fallback: true }
    ])
  })

  it('returns a single covered run for plain text', () => {
    expect(splitRunsByCoverage('Hello', latin)).toEqual([{ text: 'Hello', fallback: false }])
  })

  it('returns an empty array for empty text', () => {
    expect(splitRunsByCoverage('', latin)).toEqual([])
  })
})

// The real system emoji font drives the metrics tests — the same bytes the app
// injects. Skipped where the platform has none.
const EMOJI_SPEC = findSystemEmojiFont()
const emojiBytes = (() => {
  if (!EMOJI_SPEC || !existsSync(EMOJI_SPEC.path)) return null
  const buf = readFileSync(EMOJI_SPEC.path)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
})()

afterEach(() => {
  setEmojiFont(null)
})

describe.skipIf(emojiBytes === null)('measureAdvance with emoji fallback', () => {
  const emojiOn = (): void => setEmojiFont(() => emojiBytes as ArrayBuffer)

  it('measures emoji with the emoji font, not as .notdef in the primary font', () => {
    emojiOn()
    const withFallback = measureAdvance(loadFont, KEY, 'A 🍁 B', 80)
    setEmojiFont(null)
    const withoutFallback = measureAdvance(loadFont, KEY, 'A 🍁 B', 80)
    // A maple leaf is roughly square — far wider than Inter's .notdef box.
    expect(withFallback).toBeGreaterThan(withoutFallback + 30)
  })

  it('equals the sum of its per-run advances (no cross-font kerning)', () => {
    emojiOn()
    const total = measureAdvance(loadFont, KEY, 'A 🍁 B', 80)
    const latinOnly = measureAdvance(loadFont, KEY, 'A ', 80)
    const emojiOnly = measureAdvance(loadFont, KEY, '🍁', 80)
    const tail = measureAdvance(loadFont, KEY, ' B', 80)
    expect(total).toBeCloseTo(latinOnly + emojiOnly + tail, 5)
  })

  it('leaves plain ASCII measurement untouched', () => {
    const withoutFallback = measureAdvance(loadFont, KEY, 'Hello world', 80)
    emojiOn()
    const withFallback = measureAdvance(loadFont, KEY, 'Hello world', 80)
    expect(withFallback).toBe(withoutFallback)
  })
})
