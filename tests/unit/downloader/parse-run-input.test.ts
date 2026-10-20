import { describe, expect, it } from 'vitest'
import {
  hasBlockingProblem,
  lineKey,
  parseRunInput
} from '../../../src/shared/downloader/parse-run-input'

const A = 'https://x.com/alice/status/1750123456789012352'
const B = 'https://x.com/bob/status/1750123456789012999'

describe('parseRunInput — physical lines and stable keys', () => {
  it('returns one entry per non-blank line, in order', () => {
    const lines = parseRunInput(`${A}\n${B}`)
    expect(lines).toHaveLength(2)
    expect(lines.map((line) => line.tweetId)).toEqual([
      '1750123456789012352',
      '1750123456789012999'
    ])
  })

  it('drops blank lines but keeps physical line numbers (no row shifting)', () => {
    const lines = parseRunInput(`\n\n${A}\n\n   \n${B}\n`)
    expect(lines.map((line) => line.lineNumber)).toEqual([3, 6])
    expect(lines.map((line) => line.key)).toEqual(['line-3', 'line-6'])
  })

  it('handles CRLF input (pasted from Windows)', () => {
    const lines = parseRunInput(`${A}\r\n${B}\r\n`)
    expect(lines.map((line) => line.lineNumber)).toEqual([1, 2])
    expect(lines[0]?.text).toBe(A)
  })

  it('lineKey is the documented shape', () => {
    expect(lineKey(7)).toBe('line-7')
  })
})

describe('parseRunInput — problems', () => {
  it('flags a junk / prose line as no-link but keeps it', () => {
    const [line] = parseRunInput('my favourite clips:')
    expect(line?.problems).toEqual(['no-link'])
    expect(line?.url).toBeNull()
    expect(line?.tweetId).toBeNull()
  })

  it('drops # comments but keeps physical line numbers', () => {
    const lines = parseRunInput(`# the funny squirrel one\n${A}\n  # trailing note\n${B}`)
    expect(lines.map((line) => line.lineNumber)).toEqual([2, 4])
    expect(lines.map((line) => line.key)).toEqual(['line-2', 'line-4'])
    expect(lines.map((line) => line.text)).toEqual([A, B])
  })

  it('only treats # at line start as a comment (never inside a URL line)', () => {
    const [line] = parseRunInput(`look at ${A} #squirrel`)
    expect(line?.tweetId).toBe('1750123456789012352')
    expect(line?.problems).toEqual([])
  })

  it('flags an implausible id as invalid-id', () => {
    const [line] = parseRunInput('https://x.com/alice/status/1')
    expect(line?.problems).toEqual(['invalid-id'])
  })

  it('marks a bare 19-digit number as no-link (GUI never accepts ids)', () => {
    const [line] = parseRunInput('1750123456789012352')
    expect(line?.problems).toEqual(['no-link'])
    expect(line?.tweetId).toBeNull()
  })

  it('flags a t.co short link as short-link (will expand), with no id yet', () => {
    const [line] = parseRunInput('https://t.co/abc123')
    expect(line?.problems).toEqual(['short-link'])
    expect(line?.tweetId).toBeNull()
    expect(line?.url).toBe('https://t.co/abc123')
    expect(hasBlockingProblem(line!)).toBe(false)
  })

  it('flags the same post twice as duplicate, keeping both lines', () => {
    const lines = parseRunInput(`${A}\n${A}`)
    expect(lines).toHaveLength(2)
    expect(lines[0]?.problems).toEqual([])
    expect(lines[1]?.problems).toEqual(['duplicate'])
    expect(lines[1]?.tweetId).toBe('1750123456789012352')
  })

  it('flags a line with two links as multiple-links', () => {
    const [line] = parseRunInput(`${A} ${B}`)
    expect(line?.problems).toContain('multiple-links')
    expect(line?.tweetId).toBe('1750123456789012352')
  })

  it('flags a duplicate that appears on a third line', () => {
    const lines = parseRunInput(`${A}\n${B}\n${A}`)
    expect(lines[2]?.problems).toEqual(['duplicate'])
  })
})

describe('parseRunInput — real-world paste shapes', () => {
  it('extracts a URL embedded in a sentence', () => {
    const [line] = parseRunInput(`look at this ${A} lol`)
    expect(line?.tweetId).toBe('1750123456789012352')
    expect(line?.problems).toEqual([])
  })

  it('handles a quoted paste and trailing punctuation', () => {
    const [quoted] = parseRunInput(`"${A}".`)
    expect(quoted?.tweetId).toBe('1750123456789012352')
    expect(quoted?.problems).toEqual([])
  })

  it('handles scheme-less and protocol-relative pastes', () => {
    expect(parseRunInput('x.com/alice/status/1750123456789012352')[0]?.tweetId).toBe(
      '1750123456789012352'
    )
    expect(parseRunInput('//x.com/alice/status/1750123456789012352')[0]?.tweetId).toBe(
      '1750123456789012352'
    )
  })

  it('accepts the /i/web/status form', () => {
    const [line] = parseRunInput('https://x.com/i/web/status/1750123456789012352')
    expect(line?.tweetId).toBe('1750123456789012352')
    expect(line?.problems).toEqual([])
  })

  it('a per-line verdict is always present, never a dropped line', () => {
    const text = [A, 'junk', '', B, 'https://t.co/x1'].join('\n')
    const lines = parseRunInput(text)
    expect(lines).toHaveLength(4)
    for (const line of lines) {
      expect(line.text.length).toBeGreaterThan(0)
      expect(line.key).toBe(`line-${line.lineNumber}`)
    }
  })

  it('never throws on hostile input', () => {
    const hostile = [
      '\u0000',
      'x'.repeat(5000),
      'https://x.com.evil.example/a/status/123',
      '""',
      '{}',
      '🔥'
    ]
    for (const text of hostile) {
      expect(() => parseRunInput(text)).not.toThrow()
    }
  })
})
