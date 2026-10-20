import { describe, expect, it } from 'vitest'
import { selectAllChosen, selectVariant, variantScore } from '../../../src/shared/downloader/select'
import type { MediaAsset, ResolvedTweet, Variant } from '../../../src/shared/downloader/types'

function variant(partial: Partial<Variant> & { url: string }): Variant {
  return {
    bitrate: null,
    contentType: 'video/mp4',
    width: 1280,
    height: 720,
    ...partial
  }
}

function asset(variants: Variant[], extra: Partial<MediaAsset> = {}): MediaAsset {
  return {
    index: 1,
    kind: 'video',
    variants,
    width: 1280,
    height: 720,
    posterUrl: null,
    ...extra
  }
}

const LADDER = asset([
  variant({ url: 'https://v/320.mp4', bitrate: 320_000, width: 480, height: 270 }),
  variant({ url: 'https://v/640.mp4', bitrate: 640_000, width: 640, height: 360 }),
  variant({ url: 'https://v/832.mp4', bitrate: 832_000, width: 1280, height: 720 }),
  variant({ url: 'https://v/2178.mp4', bitrate: 2_178_000, width: 1920, height: 1080 })
])

describe('selectVariant — best / worst', () => {
  it('best picks the highest bitrate', () => {
    expect(selectVariant(LADDER, 'best')?.variant.url).toBe('https://v/2178.mp4')
  })

  it('worst picks the lowest bitrate', () => {
    expect(selectVariant(LADDER, 'worst')?.variant.url).toBe('https://v/320.mp4')
  })

  it('returns the asset index on the chosen object', () => {
    const chosen = selectVariant(asset(LADDER.variants, { index: 3 }), 'best')
    expect(chosen?.index).toBe(3)
    expect(chosen?.media.index).toBe(3)
  })

  it('never downloads a photo asset', () => {
    expect(
      selectVariant(asset([variant({ url: 'https://p/x.jpg' })], { kind: 'photo' }), 'best')
    ).toBeNull()
  })

  it('returns null when no variant is downloadable', () => {
    expect(selectVariant(asset([]), 'best')).toBeNull()
  })

  it('selects from a gif asset (X serves silent MP4s)', () => {
    const gif = asset(
      [variant({ url: 'https://v/gif.mp4', bitrate: 0, width: 320, height: 180 })],
      {
        kind: 'gif'
      }
    )
    expect(selectVariant(gif, 'worst')?.variant.url).toBe('https://v/gif.mp4')
  })
})

describe('selectVariant — maxHeight is a closest fit, never an error', () => {
  it('picks the closest fit from below', () => {
    expect(selectVariant(LADDER, { maxHeight: 720 })?.variant.url).toBe('https://v/832.mp4')
  })

  it('picks the closest fit from above when nothing is under the cap', () => {
    const tall = asset([
      variant({ url: 'https://v/1080.mp4', bitrate: 2_000_000, height: 1080 }),
      variant({ url: 'https://v/1440.mp4', bitrate: 3_000_000, height: 1440 })
    ])
    expect(selectVariant(tall, { maxHeight: 720 })?.variant.url).toBe('https://v/1080.mp4')
  })

  it('falls back to best when no variant carries a height', () => {
    const blind = asset([
      variant({ url: 'https://v/a.mp4', bitrate: 100, height: null, width: null }),
      variant({ url: 'https://v/b.mp4', bitrate: 900, height: null, width: null })
    ])
    expect(selectVariant(blind, { maxHeight: 720 })?.variant.url).toBe('https://v/b.mp4')
  })

  it('uses the asset dims when the variant has none (syndication payloads)', () => {
    const shaped = asset(
      [
        variant({ url: 'https://v/low.mp4', bitrate: 100, height: null, width: null }),
        variant({ url: 'https://v/high.mp4', bitrate: 900, height: null, width: null })
      ],
      { width: 640, height: 360 }
    )
    // Both share the asset's 360px height, so the bitrate tie-break decides.
    expect(selectVariant(shaped, { maxHeight: 480 })?.variant.url).toBe('https://v/high.mp4')
  })
})

describe('selectVariant — the ladder lies, the score does not', () => {
  it('scoring never yields NaN for null or 0 bitrate', () => {
    expect(variantScore(variant({ url: 'a', bitrate: null, width: 100, height: 50 }))).toBe(5000)
    expect(variantScore(variant({ url: 'b', bitrate: 0, width: 100, height: 50 }))).toBe(5000)
    expect(variantScore(variant({ url: 'c', bitrate: 640_000 }))).toBe(640_000)
    expect(variantScore(variant({ url: 'd', bitrate: null, width: null, height: null }))).toBe(0)
  })

  it('a null-bitrate variant still wins on pixel area (fxtwitter payloads)', () => {
    const fx = asset([
      variant({ url: 'https://v/small.mp4', bitrate: null, width: 640, height: 360 }),
      variant({ url: 'https://v/big.mp4', bitrate: null, width: 1920, height: 1080 })
    ])
    expect(selectVariant(fx, 'best')?.variant.url).toBe('https://v/big.mp4')
    expect(selectVariant(fx, 'worst')?.variant.url).toBe('https://v/small.mp4')
  })

  it('all-zero-bitrate ties resolve deterministically by URL', () => {
    const tie = asset([
      variant({ url: 'https://v/b.mp4', bitrate: 0, width: 0, height: 0 }),
      variant({ url: 'https://v/a.mp4', bitrate: 0, width: 0, height: 0 })
    ])
    const first = selectVariant(tie, 'best')?.variant.url
    const reversed = selectVariant(asset([...tie.variants].reverse()), 'best')?.variant.url
    expect(first).toBe('https://v/a.mp4')
    expect(reversed).toBe(first)
  })

  it('is order-independent for the whole ladder', () => {
    const shuffled = asset([...LADDER.variants].reverse())
    for (const quality of ['best', 'worst'] as const) {
      expect(selectVariant(shuffled, quality)?.variant.url).toBe(
        selectVariant(LADDER, quality)?.variant.url
      )
    }
    expect(selectVariant(shuffled, { maxHeight: 720 })?.variant.url).toBe(
      selectVariant(LADDER, { maxHeight: 720 })?.variant.url
    )
  })

  it('ignores HLS variants while a progressive MP4 exists', () => {
    const mixed = asset([
      variant({
        url: 'https://v/master.m3u8',
        bitrate: 5_000_000,
        contentType: 'application/x-mpegURL'
      }),
      variant({ url: 'https://v/832.mp4', bitrate: 832_000 })
    ])
    expect(selectVariant(mixed, 'best')?.variant.url).toBe('https://v/832.mp4')
  })

  it('returns null when only HLS is available (D5 remux scope)', () => {
    const hlsOnly = asset([
      variant({ url: 'https://v/master.m3u8', contentType: 'application/x-mpegURL' })
    ])
    expect(selectVariant(hlsOnly, 'best')).toBeNull()
  })

  it('skips variants with an empty URL', () => {
    const broken = asset([
      variant({ url: '', bitrate: 9_000_000 }),
      variant({ url: 'https://v/a.mp4' })
    ])
    expect(selectVariant(broken, 'best')?.variant.url).toBe('https://v/a.mp4')
  })
})

describe('selectAllChosen', () => {
  function tweet(media: MediaAsset[]): ResolvedTweet {
    return {
      ref: {
        tweetId: '1750123456789012352',
        screenName: 'someuser',
        canonicalUrl: 'https://x.com/someuser/status/1750123456789012352'
      },
      author: { screenName: 'someuser', displayName: null, verified: false },
      text: 'hi',
      createdAt: null,
      media,
      source: 'syndication'
    }
  }

  it('returns one chosen variant per video/gif asset, in post order', () => {
    const chosen = selectAllChosen(
      tweet([
        asset(LADDER.variants, { index: 1 }),
        asset([variant({ url: 'https://p/1.jpg' })], { index: 2, kind: 'photo' }),
        asset([variant({ url: 'https://v/second.mp4', bitrate: 500 })], { index: 3 })
      ]),
      'best'
    )
    expect(chosen.map((c) => c.index)).toEqual([1, 3])
  })

  it('returns an empty list for a photo-only post (NO_VIDEO upstream)', () => {
    const chosen = selectAllChosen(
      tweet([asset([variant({ url: 'https://p/1.jpg' })], { index: 1, kind: 'photo' })]),
      'best'
    )
    expect(chosen).toEqual([])
  })
})
