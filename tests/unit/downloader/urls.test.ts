import { describe, expect, it } from 'vitest'
import {
  canonicalUrl,
  extractAllStatusUrls,
  extractStatusUrl,
  isAllowedMediaUrl,
  isTcoUrl,
  parseStatusUrl
} from '../../../src/shared/downloader/urls'
import { DlError } from '../../../src/shared/downloader/errors'

const ID = '1750123456789012352'

function codeOf(fn: () => unknown): string {
  try {
    fn()
    return 'NO_THROW'
  } catch (error) {
    return error instanceof DlError ? error.code : `NOT_DL:${String(error)}`
  }
}

describe('URL grammar — every accepted link form', () => {
  const forms: ReadonlyArray<readonly [string, string | null]> = [
    [`https://x.com/someuser/status/${ID}`, 'someuser'],
    [`https://twitter.com/someuser/status/${ID}`, 'someuser'],
    [`https://www.x.com/someuser/status/${ID}`, 'someuser'],
    [`https://mobile.twitter.com/someuser/status/${ID}`, 'someuser'],
    [`https://x.com/someuser/statuses/${ID}`, 'someuser'],
    [`x.com/someuser/status/${ID}`, 'someuser'],
    [`//x.com/someuser/status/${ID}`, 'someuser'],
    [`http://x.com/someuser/status/${ID}`, 'someuser'],
    [`https://x.com:443/someuser/status/${ID}`, 'someuser'],
    [`https://x.com/someuser/status/${ID}/photo/1`, 'someuser'],
    [`https://x.com/someuser/status/${ID}?s=20&t=abcdef`, 'someuser'],
    [`https://x.com/i/web/status/${ID}`, null],
    [`https://twitter.com/i/web/statuses/${ID}`, null],
    [`https://x.com/intent/post?tweet_id=${ID}`, null],
    [`https://x.com/someuser/intent/post?tweet_id=${ID}`, null],
    [`https://x.com/someuser/intent/tweet?tweet_id=${ID}`, null],
    [`https://platform.twitter.com/embed/Tweet.html?id=${ID}&theme=dark`, null],
    [`https://fxtwitter.com/someuser/status/${ID}`, 'someuser'],
    [`https://vxtwitter.com/someuser/status/${ID}`, 'someuser'],
    [`https://fixupx.com/someuser/status/${ID}`, 'someuser'],
    [`https://twittpr.com/someuser/status/${ID}`, 'someuser']
  ]

  it.each(forms)('parses %s', (input, screenName) => {
    const ref = parseStatusUrl(input)
    expect(ref.tweetId).toBe(ID)
    expect(ref.screenName).toBe(screenName)
    expect(ref.canonicalUrl).toBe(`https://x.com/${screenName ?? 'i'}/status/${ID}`)
  })

  it('extracts a status URL embedded in a sentence', () => {
    const ref = parseStatusUrl(`look at this https://x.com/someuser/status/${ID} lol`)
    expect(ref.tweetId).toBe(ID)
    expect(ref.screenName).toBe('someuser')
  })

  it('accepts a quoted paste (Explorer/clipboard style)', () => {
    const ref = parseStatusUrl(`"https://x.com/someuser/status/${ID}"`)
    expect(ref.tweetId).toBe(ID)
  })

  it('accepts a URL wrapped in brackets', () => {
    expect(parseStatusUrl(`(https://x.com/someuser/status/${ID})`).tweetId).toBe(ID)
    expect(parseStatusUrl(`<https://x.com/someuser/status/${ID}>`).tweetId).toBe(ID)
  })

  it('tolerates trailing punctuation', () => {
    for (const suffix of ['.', ',', '!', '..', ')', ']', '"', "'"]) {
      const ref = parseStatusUrl(`https://x.com/someuser/status/${ID}${suffix}`)
      expect(ref.tweetId).toBe(ID)
    }
  })

  it('trims surrounding whitespace', () => {
    expect(parseStatusUrl(`   https://x.com/someuser/status/${ID}\n`).tweetId).toBe(ID)
  })

  it('canonicalUrl defaults the display handle to "i"', () => {
    expect(canonicalUrl(ID, null)).toBe(`https://x.com/i/status/${ID}`)
    expect(canonicalUrl(ID, 'someuser')).toBe(`https://x.com/someuser/status/${ID}`)
  })
})

describe('URL grammar — hostile hosts (DA10)', () => {
  const hostile = [
    `https://evil.example/x.com/a/status/${ID}`,
    `https://x.com.evil.example/a/status/${ID}`,
    `https://max.com/x.com/a/status/${ID}`,
    `https://evil.example/?u=https://x.com/a/status/${ID}`,
    `ftp://x.com/a/status/${ID}`,
    `https://notx.com/a/status/${ID}`,
    `https://x.company/a/status/${ID}`,
    `https://evilx.com/a/status/${ID}`,
    `https://x.com/status/${ID}`,
    'totally not a link',
    '',
    '   '
  ]

  it.each(hostile)('rejects %s with URL_UNRECOGNIZED', (input) => {
    expect(codeOf(() => parseStatusUrl(input))).toBe('URL_UNRECOGNIZED')
  })

  it('no request could be made: extraction finds nothing in a hostile string', () => {
    for (const input of hostile) {
      expect(extractStatusUrl(input)).toBeNull()
    }
  })
})

describe('URL grammar — ids', () => {
  it('rejects a 1-digit id as TWEET_ID_INVALID, not URL_UNRECOGNIZED', () => {
    expect(codeOf(() => parseStatusUrl('https://x.com/a/status/1'))).toBe('TWEET_ID_INVALID')
  })

  it('rejects a 20-digit id as TWEET_ID_INVALID', () => {
    expect(codeOf(() => parseStatusUrl('https://x.com/a/status/12345678901234567890'))).toBe(
      'TWEET_ID_INVALID'
    )
  })

  it('accepts the 2-digit and 19-digit bounds', () => {
    expect(parseStatusUrl('https://x.com/a/status/20').tweetId).toBe('20')
    expect(parseStatusUrl(`https://x.com/a/status/${ID}`).tweetId).toBe(ID)
  })

  it('rejects a bare id in GUI mode', () => {
    expect(codeOf(() => parseStatusUrl(ID))).toBe('URL_UNRECOGNIZED')
    expect(codeOf(() => parseStatusUrl('12345'))).toBe('URL_UNRECOGNIZED')
  })

  it('accepts a bare id only in explicit --id mode', () => {
    const ref = parseStatusUrl(ID, { allowBareId: true })
    expect(ref.tweetId).toBe(ID)
    expect(ref.screenName).toBeNull()
    expect(ref.canonicalUrl).toBe(`https://x.com/i/status/${ID}`)
  })

  it('a bare id in the middle of a paragraph never becomes a download', () => {
    expect(codeOf(() => parseStatusUrl(`my notes: ${ID} and more`))).toBe('URL_UNRECOGNIZED')
  })
})

describe('URL grammar — t.co short links need one expansion hop', () => {
  it('detects a short link', () => {
    expect(isTcoUrl('https://t.co/abc123')).toBe(true)
    expect(isTcoUrl('t.co/abc123')).toBe(true)
    expect(isTcoUrl('//t.co/abc123')).toBe(true)
    expect(isTcoUrl('https://x.com/a/status/20')).toBe(false)
  })

  it('refuses to invent an id for a short link', () => {
    const error = (() => {
      try {
        parseStatusUrl('https://t.co/abc123')
        return null
      } catch (caught) {
        return caught as DlError
      }
    })()
    expect(error).toBeInstanceOf(DlError)
    expect(error?.code).toBe('URL_UNRECOGNIZED')
    expect(error?.detail).toContain('expansion')
  })

  it('extraction still surfaces the t.co URL for the core to expand', () => {
    expect(extractStatusUrl('see https://t.co/abc123')).toBe('https://t.co/abc123')
  })

  it('prefers a real status link over a t.co link on the same line', () => {
    const ref = parseStatusUrl(`https://t.co/abc https://x.com/a/status/${ID}`)
    expect(ref.tweetId).toBe(ID)
  })
})

describe('extractStatusUrl / extractAllStatusUrls', () => {
  it('returns the URL substring without quotes or punctuation', () => {
    expect(extractStatusUrl(`"https://x.com/a/status/${ID}".`)).toBe(`https://x.com/a/status/${ID}`)
  })

  it('returns null when there is no link', () => {
    expect(extractStatusUrl('nothing here')).toBeNull()
    expect(extractStatusUrl('')).toBeNull()
  })

  it('collects every distinct link for multiple-links detection', () => {
    const all = extractAllStatusUrls(`https://x.com/a/status/${ID} https://x.com/b/status/21`)
    expect(all).toHaveLength(2)
  })

  it('does not double count the same link', () => {
    expect(extractAllStatusUrls(`https://x.com/a/status/${ID}`)).toHaveLength(1)
  })
})

describe('media allow-list (D-A9 / DA10)', () => {
  const allowed = [
    'https://video.twimg.com/ext_tw_video/1/pu/vid/1280x720/abc.mp4?tag=12',
    'https://pbs.twimg.com/media/abc.jpg',
    'https://ton.twimg.com/x.mp4',
    'https://twimg.com/a.mp4',
    'https://VIDEO.TWIMG.COM/a.mp4'
  ]
  const rejected = [
    'http://video.twimg.com/a.mp4',
    'https://evil-twimg.com/a.mp4',
    'https://twimg.com.evil.example/a.mp4',
    'https://video.twimg.com.evil.example/a.mp4',
    'https://api.x.com/a.mp4',
    'https://x.com/a.mp4',
    'https://video.twitter.com/a.mp4',
    'https://notwimg.com/a.mp4',
    'not a url',
    '',
    'file:///C:/a.mp4'
  ]

  it.each(allowed)('allows %s', (url) => {
    expect(isAllowedMediaUrl(url)).toBe(true)
  })

  it.each(rejected)('rejects %s', (url) => {
    expect(isAllowedMediaUrl(url)).toBe(false)
  })
})
