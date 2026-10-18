import { describe, expect, it } from 'vitest'
import {
  ascentPx,
  clearFontCache,
  fontCacheSize,
  fontKeyFor,
  measureAdvance,
  wrapAndShrink,
  wrapText,
  type FontKey,
  type FontLoader
} from '../../src/shared/layout/text'
import { loadFont } from '../helpers/env'

const KEY: FontKey = 'inter-600'

describe('fontKeyFor', () => {
  it('maps inter weights to the bundled statics', () => {
    expect(fontKeyFor('inter', 400)).toBe('inter-400')
    expect(fontKeyFor('inter', 500)).toBe('inter-400')
    expect(fontKeyFor('inter', 600)).toBe('inter-600')
    expect(fontKeyFor('inter', 800)).toBe('inter-800')
  })

  it('maps every poppins weight to the single bundled static', () => {
    expect(fontKeyFor('poppins', 400)).toBe('poppins-600')
    expect(fontKeyFor('poppins', 800)).toBe('poppins-600')
  })
})

describe('measureAdvance / ascentPx', () => {
  it('scales advances with font size', () => {
    const at68 = measureAdvance(loadFont, KEY, 'Hello world', 68)
    const at34 = measureAdvance(loadFont, KEY, 'Hello world', 34)
    expect(at68).toBeGreaterThan(0)
    expect(at68).toBeCloseTo(at34 * 2, 0)
  })

  it('returns 0 for empty text and a sane ascent', () => {
    expect(measureAdvance(loadFont, KEY, '', 68)).toBe(0)
    const ascent = ascentPx(loadFont, KEY, 68)
    expect(ascent).toBeGreaterThan(40)
    expect(ascent).toBeLessThan(80)
  })
})

describe('wrapText', () => {
  it('greedy-wraps at word boundaries and preserves every word', () => {
    const text = 'the quick brown fox jumps over the lazy dog'
    const lines = wrapText(loadFont, KEY, text, 68, 600, 'normal')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join(' ')).toBe(text)
    for (const line of lines) {
      if (line.includes(' ')) {
        expect(measureAdvance(loadFont, KEY, line, 68)).toBeLessThanOrEqual(600)
      }
    }
  })

  it('preserves explicit paragraph breaks including empty lines', () => {
    const lines = wrapText(loadFont, KEY, 'first\n\nsecond', 68, 880, 'normal')
    expect(lines).toEqual(['first', '', 'second'])
  })

  it('keeps an overlong word whole in normal mode', () => {
    const word = 'SupercalifragilisticexpialidociousSupercalifragilisticexpialidocious'
    const lines = wrapText(loadFont, KEY, word, 68, 200, 'normal')
    expect(lines).toEqual([word])
  })

  it('splits an overlong word when wordBreak is break-word', () => {
    const word = 'A'.repeat(60)
    const lines = wrapText(loadFont, KEY, word, 68, 200, 'break-word')
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.join('')).toBe(word)
    for (const line of lines) {
      expect(measureAdvance(loadFont, KEY, line, 68)).toBeLessThanOrEqual(200)
    }
  })
})

describe('wrapAndShrink', () => {
  const base = {
    loader: loadFont,
    fontKey: KEY,
    maxWidth: 880,
    fontSize: 68,
    fontSizeMin: 44,
    maxLines: 4,
    wordBreak: 'normal' as const
  }

  it('keeps the requested size when the text already fits', () => {
    const result = wrapAndShrink({ ...base, text: 'Short hook' })
    expect(result).not.toBeNull()
    expect(result?.fontSize).toBe(68)
    expect(result?.shrunkToFloor).toBe(false)
  })

  it('steps the size down until the text fits maxLines', () => {
    const text = Array.from({ length: 20 }, (_, i) => `word${String(i).padStart(2, '0')}`).join(' ')
    // Precondition: at the requested size the text needs more than 4 lines.
    expect(wrapText(loadFont, KEY, text, 68, 880, 'normal').length).toBeGreaterThan(4)
    const result = wrapAndShrink({ ...base, text })
    expect(result).not.toBeNull()
    expect(result?.lines.length).toBeLessThanOrEqual(4)
    expect(result?.fontSize).toBeLessThan(68)
    expect(result?.fontSize).toBeGreaterThanOrEqual(44)
  })

  it('returns null when even the floor cannot fit', () => {
    const text = 'materializing '.repeat(30)
    expect(wrapAndShrink({ ...base, text })).toBeNull()
  })
})

describe('font cache', () => {
  it('parses each font once per stable loader identity', () => {
    clearFontCache()
    let loads = 0
    const counting: FontLoader = (key) => {
      loads += 1
      return loadFont(key)
    }
    for (let i = 0; i < 10; i += 1) {
      measureAdvance(counting, 'inter-600', 'Hello world', 68)
      ascentPx(counting, 'inter-400', 68)
    }
    expect(loads).toBe(2)
    expect(fontCacheSize()).toBe(1)
  })

  it('stays bounded when a host passes a fresh loader per call', () => {
    clearFontCache()
    for (let i = 0; i < 50; i += 1) {
      const fresh: FontLoader = (key) => loadFont(key)
      measureAdvance(fresh, 'inter-600', 'x', 68)
    }
    expect(fontCacheSize()).toBeLessThanOrEqual(4)
  })
})
