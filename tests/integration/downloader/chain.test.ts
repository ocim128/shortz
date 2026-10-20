import { describe, expect, it } from 'vitest'
import { createDlClient } from '../../../src/core/downloader/net/client'
import {
  FallbackChain,
  buildChain,
  createOembedProbe,
  oembedProbeUrl,
  terminalError
} from '../../../src/core/downloader/resolve/chain'
import type { ResolveCtx } from '../../../src/core/downloader/resolve/ctx'
import {
  FxTwitterResolver,
  fxTwitterUrl,
  mapFxTwitterPayload
} from '../../../src/core/downloader/resolve/fxtwitter'
import {
  SyndicationResolver,
  mapSyndicationPayload,
  syndicationUrl
} from '../../../src/core/downloader/resolve/syndication'
import { DlError } from '../../../src/shared/downloader/errors'
import { selectAllChosen } from '../../../src/shared/downloader/select'
import { syndicationToken } from '../../../src/shared/downloader/token'
import type { TweetRef } from '../../../src/shared/downloader/types'
import {
  fakeFetch,
  jsonResponse,
  readFixture,
  readFixtureBody,
  type FakeRoute
} from '../../unit/downloader/helpers/fixtures'

const SINGLE_ID = '1750123456789012352'
const MULTI_ID = '1750123456789012353'
const GIF_ID = '1750123456789012354'
const PHOTO_ID = '1750123456789012355'

function refOf(tweetId: string, screenName: string | null = 'someuser'): TweetRef {
  const user = screenName ?? 'i'
  return {
    tweetId,
    screenName,
    canonicalUrl: `https://x.com/${user}/status/${tweetId}`
  }
}

function syndicationRoute(fixture: string): FakeRoute {
  const { status, body } = readFixture(`syndication/${fixture}`)
  return {
    match: 'cdn.syndication.twimg.com/tweet-result',
    respond: () => (status === 200 ? jsonResponse(body) : new Response(null, { status }))
  }
}

function fxRoute(fixture: string): FakeRoute {
  const { status, body } = readFixture(`fxtwitter/${fixture}`)
  return {
    match: 'api.fxtwitter.com/status/',
    respond: () => (status === 200 ? jsonResponse(body) : new Response(null, { status }))
  }
}

function oembedRoute(status: number): FakeRoute {
  return { match: 'publish.twitter.com/oembed', respond: () => new Response(null, { status }) }
}

function clientFor(routes: FakeRoute[], fallback: 'off' | 'fxtwitter' | 'auto' = 'off') {
  const fetchImpl = fakeFetch(routes)
  return { fetchImpl, client: createDlClient({ fetchImpl, fallback }) }
}

function ctxOf(
  client: ReturnType<typeof createDlClient>,
  requests = { count: 0 }
): ResolveCtx & { requests: { count: number } } {
  return {
    client,
    signal: new AbortController().signal,
    onRequest: () => {
      requests.count += 1
    },
    requests
  }
}

describe('syndication adapter — payload mapping (fixtures)', () => {
  it('maps a single-video payload', () => {
    const resolved = mapSyndicationPayload(
      refOf(SINGLE_ID),
      readFixtureBody('syndication/single-video.json')
    )
    expect(resolved.source).toBe('syndication')
    expect(resolved.author).toEqual({
      screenName: 'someuser',
      displayName: 'Some User',
      verified: true
    })
    expect(resolved.text).toBe('A single video post')
    expect(resolved.createdAt).toBe('2024-01-31T12:34:56.000Z')
    expect(resolved.media).toHaveLength(1)
    const asset = resolved.media[0]!
    expect(asset.index).toBe(1)
    expect(asset.kind).toBe('video')
    expect(asset.posterUrl).toBe('https://pbs.twimg.com/media/single-video.jpg')
    expect(asset.width).toBe(1280)
    expect(asset.height).toBe(720)
    // HLS is kept in the payload, selection ignores it.
    expect(asset.variants).toHaveLength(4)
    const mp4 = asset.variants.filter((variant) => variant.contentType === 'video/mp4')
    expect(mp4.map((variant) => variant.bitrate)).toEqual([320000, 832000, 2176000])
    // No per-variant dims in these URLs, so the asset-level dims are inherited.
    expect(mp4.every((variant) => variant.height === 720)).toBe(true)
  })

  it('reads per-variant dimensions from the twimg path when the payload has none', () => {
    const payload = {
      __typename: 'Tweet',
      id_str: SINGLE_ID,
      text: 'a real ladder',
      created_at: '2024-01-31T12:34:56.000Z',
      user: { screen_name: 'someuser', name: 'Some User', verified: false },
      mediaDetails: [
        {
          type: 'video',
          original_info: { width: 3840, height: 2160 },
          media_url_https: 'https://pbs.twimg.com/media/ladder.jpg',
          video_info: {
            variants: [
              {
                content_type: 'video/mp4',
                bitrate: 288_000,
                url: 'https://video.twimg.com/amplify_video/1/vid/avc1/480x270/a.mp4'
              },
              {
                content_type: 'video/mp4',
                bitrate: 2_176_000,
                url: 'https://video.twimg.com/amplify_video/1/vid/avc1/1280x720/b.mp4'
              },
              {
                content_type: 'application/x-mpegURL',
                url: 'https://video.twimg.com/amplify_video/1/pl/x.m3u8'
              }
            ]
          }
        }
      ]
    }

    const resolved = mapSyndicationPayload(refOf(SINGLE_ID), payload)
    expect(resolved.media[0]?.variants.map((one) => [one.width, one.height])).toEqual([
      [480, 270],
      [1280, 720],
      // The HLS playlist has no path dims: the asset dims remain the fallback.
      [3840, 2160]
    ])

    // maxHeight must now choose the real 720p rung, not the biggest bitrate.
    const chosen = selectAllChosen(resolved, { maxHeight: 720 })
    expect(chosen[0]?.variant.url).toContain('/1280x720/')
  })

  it('maps a multi-video payload, both timestamp formats and sizes.large dims', () => {
    const resolved = mapSyndicationPayload(
      refOf(MULTI_ID, 'multiuser'),
      readFixtureBody('syndication/multi-video.json')
    )
    expect(resolved.media.map((asset) => asset.index)).toEqual([1, 2, 3])
    // Twitter's `Wed Oct 22 15:33:18 +0000 2020` form.
    expect(resolved.createdAt).toBe('2020-10-22T15:33:18.000Z')
    // Third asset has no original_info: dims come from sizes.large.
    expect(resolved.media[2]?.width).toBe(1920)
    expect(resolved.media[2]?.height).toBe(1080)
  })

  it('maps animated_gif to kind "gif"', () => {
    const resolved = mapSyndicationPayload(
      refOf(GIF_ID, 'gifuser'),
      readFixtureBody('syndication/gif.json')
    )
    expect(resolved.media[0]?.kind).toBe('gif')
    expect(resolved.media[0]?.variants[0]?.bitrate).toBe(0)
  })

  it('maps a photo-only post to photo assets with no variants', () => {
    const resolved = mapSyndicationPayload(
      refOf(PHOTO_ID, 'photouser'),
      readFixtureBody('syndication/photo-only.json')
    )
    expect(resolved.media).toHaveLength(2)
    expect(resolved.media.every((asset) => asset.kind === 'photo')).toBe(true)
    expect(resolved.media.every((asset) => asset.variants.length === 0)).toBe(true)
  })

  it('maps a tombstone to NOT_EMBEDDABLE (never NOT_FOUND)', () => {
    expect(() =>
      mapSyndicationPayload(refOf(SINGLE_ID), readFixtureBody('syndication/tombstone.json'))
    ).toThrow(expect.objectContaining({ code: 'NOT_EMBEDDABLE' }))
  })

  it('rejects a payload for a different id as UPSTREAM_ERROR', () => {
    expect(() =>
      mapSyndicationPayload(
        refOf('1750123456789099999'),
        readFixtureBody('syndication/single-video.json')
      )
    ).toThrow(expect.objectContaining({ code: 'UPSTREAM_ERROR' }))
  })

  it('rejects an unparseable timestamp as UPSTREAM_ERROR', () => {
    const payload = {
      ...(readFixtureBody('syndication/single-video.json') as Record<string, unknown>),
      created_at: 'not a date at all'
    }
    expect(() => mapSyndicationPayload(refOf(SINGLE_ID), payload)).toThrow(
      expect.objectContaining({ code: 'UPSTREAM_ERROR' })
    )
  })
})

describe('syndication adapter — request shape and error mapping', () => {
  it('sends id, lang, the computed token and the pinned features', async () => {
    const { fetchImpl, client } = clientFor([syndicationRoute('single-video.json')])
    await new SyndicationResolver().resolve(refOf(SINGLE_ID), ctxOf(client))
    const url = fetchImpl.urls()[0] ?? ''
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://cdn.syndication.twimg.com')
    expect(parsed.pathname).toBe('/tweet-result')
    expect(parsed.searchParams.get('id')).toBe(SINGLE_ID)
    expect(parsed.searchParams.get('lang')).toBe('en')
    expect(parsed.searchParams.get('token')).toBe(syndicationToken(SINGLE_ID))
    expect(parsed.searchParams.get('features')).toContain('tfw_timeline_list:')
    expect(syndicationUrl(SINGLE_ID)).toBe(url)
  })

  it('maps a 404 to NOT_EMBEDDABLE (the endpoint cannot say "deleted")', async () => {
    const { client } = clientFor([syndicationRoute('sensitive-404.json')])
    await expect(
      new SyndicationResolver().resolve(refOf(SINGLE_ID), ctxOf(client))
    ).rejects.toMatchObject({ code: 'NOT_EMBEDDABLE' })
  })

  it('maps 401/403 to AUTH_REQUIRED and 429 to RATE_LIMITED', async () => {
    for (const [status, code] of [
      [401, 'AUTH_REQUIRED'],
      [403, 'AUTH_REQUIRED'],
      [429, 'RATE_LIMITED'],
      [500, 'UPSTREAM_ERROR'],
      [503, 'UPSTREAM_ERROR']
    ] as const) {
      const { client } = clientFor([
        { match: 'cdn.syndication.twimg.com', respond: () => new Response(null, { status }) }
      ])
      await expect(
        new SyndicationResolver().resolve(refOf(SINGLE_ID), ctxOf(client))
      ).rejects.toMatchObject({ code })
    }
  })
})

describe('fxtwitter adapter — payload mapping and error mapping', () => {
  it('maps a single progressive MP4 with bitrate null', () => {
    const resolved = mapFxTwitterPayload(
      refOf(SINGLE_ID),
      readFixtureBody('fxtwitter/single-video.json')
    )
    expect(resolved.source).toBe('fxtwitter')
    expect(resolved.createdAt).toBe('2024-01-31T12:34:56.000Z')
    const asset = resolved.media[0]!
    expect(asset.kind).toBe('video')
    expect(asset.width).toBe(1280)
    expect(asset.variants).toHaveLength(1)
    expect(asset.variants[0]?.bitrate).toBeNull()
    expect(asset.variants[0]?.contentType).toBe('video/mp4')
  })

  it('maps gif videos and the unix created_timestamp fallback', () => {
    const resolved = mapFxTwitterPayload(
      refOf(GIF_ID, 'gifuser'),
      readFixtureBody('fxtwitter/gif.json')
    )
    expect(resolved.media[0]?.kind).toBe('gif')
    expect(resolved.createdAt).toBe(new Date(1685606400 * 1000).toISOString())
  })

  it('rejects a payload without a tweet object as NOT_FOUND', () => {
    expect(() =>
      mapFxTwitterPayload(refOf(SINGLE_ID), readFixtureBody('fxtwitter/missing-tweet.json'))
    ).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })

  it('hits /status/<id>', async () => {
    const { fetchImpl, client } = clientFor([fxRoute('single-video.json')], 'fxtwitter')
    await new FxTwitterResolver().resolve(refOf(SINGLE_ID), ctxOf(client))
    expect(fetchImpl.urls()[0]).toBe(fxTwitterUrl(SINGLE_ID))
  })
})

describe('chain folding — terminal error priority (AUDIT A1)', () => {
  const names = ['syndication', 'fxtwitter'] as const

  it('a non-primary 404 folds to NOT_EMBEDDABLE (DA11)', () => {
    const error = terminalError(
      [new DlError('NOT_EMBEDDABLE', 'syndication refused'), new DlError('NOT_FOUND', 'fx 404')],
      names
    )
    expect(error.code).toBe('NOT_EMBEDDABLE')
    expect(error.detail).toContain('tried: syndication → fxtwitter')
  })

  it('a primary NOT_FOUND is terminal', () => {
    const error = terminalError(
      [new DlError('NOT_FOUND', 'primary says gone'), new DlError('NOT_EMBEDDABLE', 'fx')],
      names
    )
    expect(error.code).toBe('NOT_FOUND')
  })

  it('RATE_LIMITED wins over a generic last error', () => {
    const error = terminalError(
      [new DlError('RATE_LIMITED', '429'), new DlError('UPSTREAM_ERROR', '500')],
      names
    )
    expect(error.code).toBe('RATE_LIMITED')
  })

  it('otherwise the last adapter error decides, with the trail', () => {
    const error = terminalError(
      [new DlError('UPSTREAM_ERROR', 'first'), new DlError('AUTH_REQUIRED', 'second')],
      names
    )
    expect(error.code).toBe('AUTH_REQUIRED')
    expect(error.detail).toContain('tried: syndication → fxtwitter')
  })

  it('the probe may upgrade a refusal to NOT_FOUND, or confirm it', () => {
    const errors = [new DlError('NOT_EMBEDDABLE', 'refused')]
    expect(terminalError(errors, ['syndication'], 'gone').code).toBe('NOT_FOUND')
    expect(terminalError(errors, ['syndication'], 'alive').code).toBe('NOT_EMBEDDABLE')
    expect(terminalError(errors, ['syndication'], 'unknown').code).toBe('NOT_EMBEDDABLE')
  })

  it('never claims NOT_FOUND from a 404-shaped fxtwitter failure alone (DA7/DA11)', () => {
    const error = terminalError(
      [new DlError('NOT_EMBEDDABLE', 'syndication'), new DlError('NOT_FOUND', 'fx')],
      names,
      'alive'
    )
    expect(error.code).toBe('NOT_EMBEDDABLE')
  })
})

describe('FallbackChain — fall-through and the failure-path probe', () => {
  it('falls through every adapter and returns the first success', async () => {
    const { client, fetchImpl } = clientFor(
      [syndicationRoute('sensitive-404.json'), fxRoute('single-video.json')],
      'fxtwitter'
    )
    const resolved = await buildChain({ fallback: 'fxtwitter', client, probe: null }).resolve(
      refOf(SINGLE_ID),
      ctxOf(client)
    )
    expect(resolved.source).toBe('fxtwitter')
    expect(fetchImpl.count('cdn.syndication.twimg.com')).toBe(1)
    expect(fetchImpl.count('api.fxtwitter.com')).toBe(1)
  })

  it('with fallback off, NO fxtwitter request is made (DA7)', async () => {
    const { client, fetchImpl } = clientFor([syndicationRoute('sensitive-404.json')], 'off')
    const chain = buildChain({ fallback: 'off', client, probe: null })
    await expect(chain.resolve(refOf(SINGLE_ID), ctxOf(client))).rejects.toMatchObject({
      code: 'NOT_EMBEDDABLE'
    })
    expect(fetchImpl.count('api.fxtwitter.com')).toBe(0)
    expect(chain.names).toEqual(['syndication'])
  })

  it('DA11: fxtwitter 404 + probe alive ⇒ NOT_EMBEDDABLE, never "deleted"', async () => {
    const { client, fetchImpl } = clientFor(
      [syndicationRoute('sensitive-404.json'), fxRoute('status-404.json'), oembedRoute(200)],
      'fxtwitter'
    )
    const chain = buildChain({ fallback: 'fxtwitter', client })
    await expect(chain.resolve(refOf(SINGLE_ID), ctxOf(client))).rejects.toMatchObject({
      code: 'NOT_EMBEDDABLE'
    })
    expect(fetchImpl.count('publish.twitter.com/oembed')).toBe(1)
  })

  it('DA7: a probe 404 turns the refusal into NOT_FOUND', async () => {
    const { client } = clientFor([syndicationRoute('sensitive-404.json'), oembedRoute(404)])
    const chain = buildChain({ fallback: 'off', client })
    await expect(chain.resolve(refOf(SINGLE_ID), ctxOf(client))).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })

  it('does not probe a successful resolve', async () => {
    const { client, fetchImpl } = clientFor([
      syndicationRoute('single-video.json'),
      oembedRoute(404)
    ])
    await buildChain({ fallback: 'off', client }).resolve(refOf(SINGLE_ID), ctxOf(client))
    expect(fetchImpl.count('publish.twitter.com/oembed')).toBe(0)
  })

  it('never probes for a non-refusal failure (rate limit)', async () => {
    const { client, fetchImpl } = clientFor([
      { match: 'cdn.syndication.twimg.com', respond: () => new Response(null, { status: 429 }) },
      oembedRoute(404)
    ])
    await expect(
      buildChain({ fallback: 'off', client }).resolve(refOf(SINGLE_ID), ctxOf(client))
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(fetchImpl.count('publish.twitter.com/oembed')).toBe(0)
  })

  it("an 'unknown' probe leaves the honest three-cause refusal in place", async () => {
    const { client } = clientFor([
      syndicationRoute('sensitive-404.json'),
      { match: 'publish.twitter.com/oembed', respond: () => new Response(null, { status: 500 }) }
    ])
    await expect(
      buildChain({ fallback: 'off', client }).resolve(refOf(SINGLE_ID), ctxOf(client))
    ).rejects.toMatchObject({ code: 'NOT_EMBEDDABLE' })
  })

  it('the oembed probe URL carries the canonical URL', () => {
    expect(oembedProbeUrl('https://x.com/someuser/status/1')).toBe(
      'https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Fsomeuser%2Fstatus%2F1&omit_script=1'
    )
  })

  it('createOembedProbe maps 200/404 and swallows everything else as unknown', async () => {
    for (const [status, expected] of [
      [200, 'alive'],
      [404, 'gone'],
      [403, 'unknown']
    ] as const) {
      const { client } = clientFor([oembedRoute(status)])
      const probe = createOembedProbe(client)
      await expect(probe(refOf(SINGLE_ID), ctxOf(client))).resolves.toBe(expected)
    }
  })

  it('buildChain composition per fallback setting (D-A16: auto never mentions yt-dlp)', () => {
    const { client } = clientFor([])
    expect(buildChain({ fallback: 'off', client }).names).toEqual(['syndication'])
    expect(buildChain({ fallback: 'fxtwitter', client }).names).toEqual([
      'syndication',
      'fxtwitter'
    ])
    expect(buildChain({ fallback: 'auto', client }).names).toEqual(['syndication'])
  })

  it('a FallbackChain with no adapters fails as UPSTREAM_ERROR instead of hanging', async () => {
    const { client } = clientFor([])
    await expect(
      new FallbackChain([], null).resolve(refOf(SINGLE_ID), ctxOf(client))
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
  })

  it('rethrows a cancel instead of falling through', async () => {
    const controller = new AbortController()
    const chain = new FallbackChain(
      [
        {
          name: 'syndication',
          resolve: () => {
            controller.abort()
            return Promise.reject(new DOMException('aborted', 'AbortError'))
          }
        },
        {
          name: 'fxtwitter',
          resolve: () => Promise.resolve({} as never)
        }
      ],
      null
    )
    await expect(
      chain.resolve(refOf(SINGLE_ID), ctxOf(createDlClient({ fallback: 'off' })))
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})
