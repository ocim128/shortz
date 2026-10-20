import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FILENAME_TEMPLATE,
  MAX_RELATIVE_PATH,
  dateParts,
  joinPlannedPath,
  renderPlannedPath,
  slugify
} from '../../../src/shared/downloader/naming'
import {
  MAX_SEGMENT_LENGTH,
  sanitizeSegment,
  truncateSurrogateSafe
} from '../../../src/shared/naming'

const ID = '1750123456789012352'
const TWEET = {
  tweetId: ID,
  author: 'someuser',
  createdAt: '2024-01-31T12:34:56.000Z',
  text: 'Look at this: a great clip!'
}

function plan(
  overrides: Partial<Parameters<typeof renderPlannedPath>[0]> = {}
): ReturnType<typeof renderPlannedPath> {
  return renderPlannedPath({
    tweet: TWEET,
    mediaIndex: 1,
    layout: 'by-author',
    filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
    rootLength: 40,
    ...overrides
  })
}

describe('sanitizeSegment — the one Windows rule set (AUDIT A15)', () => {
  it('replaces characters Windows rejects', () => {
    expect(sanitizeSegment('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j')
  })

  it('replaces control characters', () => {
    expect(sanitizeSegment('a\u0000b\u001fc')).toBe('a_b_c')
  })

  it('strips trailing spaces and dots', () => {
    expect(sanitizeSegment('report.')).toBe('report')
    expect(sanitizeSegment('report  ')).toBe('report')
    expect(sanitizeSegment('report. . ')).toBe('report')
  })

  it('prefixes reserved device names, with or without an extension', () => {
    for (const name of ['CON', 'prn', 'aux', 'NUL', 'com1', 'COM9', 'lpt1']) {
      expect(sanitizeSegment(name)).toBe(`_${name}`)
    }
    expect(sanitizeSegment('CON.txt')).toBe('_CON.txt')
    expect(sanitizeSegment('CONSOLE')).toBe('CONSOLE')
    expect(sanitizeSegment('com10')).toBe('com10')
  })

  it('never returns an empty segment', () => {
    expect(sanitizeSegment('')).toBe('_')
    expect(sanitizeSegment('   ')).toBe('_')
    expect(sanitizeSegment('...')).toBe('_')
  })

  it('caps at 120 chars and re-strips trailing dots/spaces after truncation', () => {
    const long = `${'a'.repeat(119)}.extra`
    const out = sanitizeSegment(long)
    expect(out.length).toBeLessThanOrEqual(MAX_SEGMENT_LENGTH)
    expect(out.endsWith('.')).toBe(false)
    expect(sanitizeSegment('b'.repeat(400)).length).toBe(MAX_SEGMENT_LENGTH)
  })

  it('truncates on a char boundary without leaving a lone surrogate', () => {
    const emoji = '😀'.repeat(80) // each is 2 code units
    const out = sanitizeSegment(emoji)
    expect(out.length).toBeLessThanOrEqual(MAX_SEGMENT_LENGTH)
    expect(out.length % 2).toBe(0)
    const last = out.charCodeAt(out.length - 1)
    expect(last >= 0xdc00 && last <= 0xdfff).toBe(true)
    expect(truncateSurrogateSafe('ab😀', 3)).toBe('ab')
  })

  it('normalizes to NFC', () => {
    const decomposed = 'e\u0301'
    expect(sanitizeSegment(decomposed)).toBe('\u00e9')
  })
})

describe('slugify', () => {
  it('lowercases, collapses non-alphanumerics and trims dashes', () => {
    expect(slugify('Look at this: a great clip!')).toBe('look-at-this-a-great-clip')
  })

  it('degrades emoji/CJK captions to nothing rather than a broken path', () => {
    expect(slugify('🔥🔥🔥')).toBe('')
    expect(slugify('日本語のキャプション')).toBe('')
  })

  it('caps at 30 characters without a trailing dash', () => {
    const out = slugify('a'.repeat(40))
    expect(out.length).toBe(30)
    expect(slugify(`${'word '.repeat(10)}`).endsWith('-')).toBe(false)
  })
})

describe('dateParts', () => {
  it('uses the post date in local time', () => {
    const parts = dateParts('2024-01-31T12:34:56.000Z')
    expect(parts.date).toMatch(/^2024-0[12]-\d{2}$/)
    expect(parts.yyyy).toBe('2024')
  })

  it('falls back to the current date when the timestamp is absent or invalid', () => {
    const now = new Date(2026, 9, 20)
    expect(dateParts(null, now).date).toBe('2026-10-20')
    expect(dateParts('not a date', now).date).toBe('2026-10-20')
  })
})

describe('renderPlannedPath — templates and layouts', () => {
  it('defaults to {id} under x/<author>', () => {
    const path = plan()
    expect(path.dirSegments).toEqual(['x', 'someuser'])
    expect(path.fileName).toBe(`${ID}.mp4`)
    expect(path.relativePath).toBe(`x\\someuser\\${ID}.mp4`)
  })

  it('appends _v{index} from the second media asset', () => {
    expect(plan({ mediaIndex: 2 }).fileName).toBe(`${ID}_v2.mp4`)
    expect(plan({ mediaIndex: 3 }).fileName).toBe(`${ID}_v3.mp4`)
    expect(plan({ mediaIndex: 1 }).fileName).toBe(`${ID}.mp4`)
  })

  it('does not double-count when the template consumed {index} (AUDIT A21)', () => {
    const path = plan({ mediaIndex: 2, filenameTemplate: '{id}_{index}' })
    expect(path.fileName).toBe(`${ID}_2.mp4`)
  })

  it('expands {author}, {date}, {slug} and {index}', () => {
    expect(plan({ filenameTemplate: '{author}_{id}' }).fileName).toBe(`someuser_${ID}.mp4`)
    expect(plan({ filenameTemplate: '{date}_{id}' }).fileName).toMatch(/^2024-0[12]-\d{2}_/)
    expect(plan({ filenameTemplate: '{slug}' }).fileName).toBe('look-at-this-a-great-clip.mp4')
    expect(plan({ mediaIndex: 2, filenameTemplate: '{id}_{index}' }).fileName).toBe(`${ID}_2.mp4`)
  })

  it('keeps unknown tokens verbatim instead of dropping them', () => {
    expect(plan({ filenameTemplate: '{id}_{nope}' }).fileName).toBe(`${ID}_{nope}.mp4`)
  })

  it('by-date groups by the post year and month under x/', () => {
    const path = plan({ layout: 'by-date' })
    expect(path.dirSegments).toHaveLength(3)
    expect(path.dirSegments[0]).toBe('x')
    expect(path.dirSegments[1]).toBe('2024')
    expect(path.dirSegments[2]).toMatch(/^0[12]$/)
  })

  it('flat puts everything directly under x/', () => {
    expect(plan({ layout: 'flat' }).dirSegments).toEqual(['x'])
  })

  it('falls back to "unknown" when the author is null', () => {
    expect(plan({ tweet: { ...TWEET, author: null } }).dirSegments).toEqual(['x', 'unknown'])
  })

  it('sanitizes a hostile caption/author so nothing can escape the root', () => {
    const planned = plan({
      tweet: { ...TWEET, text: '..\\..\\evil', author: '..\\..\\evil' },
      filenameTemplate: '{slug}_{id}'
    })
    // No segment may contain a separator or be a traversal segment itself.
    for (const segment of [...planned.dirSegments, planned.fileName]) {
      expect(segment).not.toContain('\\')
      expect(segment).not.toContain('/')
      expect(segment).not.toBe('..')
      expect(segment).not.toBe('.')
    }
    expect(planned.fileName).toBe(`evil_${ID}.mp4`)
    const root = path.resolve('C:\\Videos\\ShortZ\\Downloads')
    const resolved = path.resolve(root, ...planned.dirSegments, planned.fileName)
    expect(resolved.startsWith(`${root}${path.sep}`)).toBe(true)
  })

  it('a 19-digit id survives every template', () => {
    for (const template of ['{id}', '{date}_{id}', '{slug}-{id}', '{author}_{id}_{index}']) {
      expect(plan({ filenameTemplate: template }).fileName).toContain(ID)
    }
  })
})

describe('renderPlannedPath — 240-char budget (AUDIT A14 / D-A2)', () => {
  it('fits a 100-char root plus a 120-char author and still contains the id', () => {
    const path = plan({
      rootLength: 100,
      tweet: { ...TWEET, author: 'a'.repeat(120) }
    })
    const total =
      100 + path.dirSegments.reduce((n, s) => n + s.length + 1, 0) + path.fileName.length
    expect(total).toBeLessThanOrEqual(MAX_RELATIVE_PATH)
    expect(path.fileName).toContain(ID)
    expect(path.dirSegments[1]?.length).toBeLessThan(120)
  })

  it('shrinks the slug before losing the id', () => {
    const path = plan({
      rootLength: 180,
      filenameTemplate: '{slug}_{id}',
      tweet: { ...TWEET, text: 'word '.repeat(20), author: 'a'.repeat(120) }
    })
    const total =
      180 + path.dirSegments.reduce((n, s) => n + s.length + 1, 0) + path.fileName.length
    expect(total).toBeLessThanOrEqual(MAX_RELATIVE_PATH)
    expect(path.fileName).toContain(ID)
  })

  it('falls back to the id-only name when even the template cannot fit', () => {
    const path = plan({
      rootLength: 200,
      filenameTemplate: `${'x'.repeat(100)}_{id}`
    })
    const total =
      200 + path.dirSegments.reduce((n, s) => n + s.length + 1, 0) + path.fileName.length
    expect(total).toBeLessThanOrEqual(MAX_RELATIVE_PATH)
    expect(path.fileName).toContain(ID)
  })
})

describe('joinPlannedPath', () => {
  it('composes the absolute path with the platform separator', () => {
    const path = plan()
    expect(joinPlannedPath('C:\\Videos\\ShortZ\\Downloads', path, '\\')).toBe(
      `C:\\Videos\\ShortZ\\Downloads\\x\\someuser\\${ID}.mp4`
    )
  })

  it('does not double a trailing separator on the root', () => {
    expect(joinPlannedPath('/tmp/out/', plan(), '/')).toBe(`/tmp/out/x/someuser/${ID}.mp4`)
  })
})
