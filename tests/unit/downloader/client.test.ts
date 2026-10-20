import { describe, expect, it } from 'vitest'
import {
  contentRangeTotal,
  createDlClient,
  isAllowedResolveUrl,
  parseRetryAfter
} from '../../../src/core/downloader/net/client'
import { DlError } from '../../../src/shared/downloader/errors'
import { fakeFetch, jsonResponse } from './helpers/fixtures'

describe('resolve allow-list (checked before a socket opens)', () => {
  it('accepts the documented resolve hosts over https only', () => {
    for (const url of [
      'https://cdn.syndication.twimg.com/tweet-result?id=1',
      'https://publish.twitter.com/oembed?url=x',
      'https://t.co/abc',
      'https://x.com/a/status/1',
      'https://twitter.com/a/status/1',
      'https://www.x.com/a/status/1',
      'https://mobile.twitter.com/a/status/1'
    ]) {
      expect(isAllowedResolveUrl(url, 'off')).toBe(true)
    }
  })

  it('rejects http, foreign hosts and lookalikes', () => {
    for (const url of [
      'http://cdn.syndication.twimg.com/tweet-result',
      'https://cdn.syndication.twimg.com.evil.example/tweet-result',
      'https://evil.example/?u=https://cdn.syndication.twimg.com/x',
      'https://api.x.com/2/tweets/1',
      'https://video.twimg.com/a.mp4',
      'not a url',
      ''
    ]) {
      expect(isAllowedResolveUrl(url, 'off')).toBe(false)
    }
  })

  it('allows api.fxtwitter.com only when the fallback is enabled', () => {
    const url = 'https://api.fxtwitter.com/status/1'
    expect(isAllowedResolveUrl(url, 'off')).toBe(false)
    expect(isAllowedResolveUrl(url, 'fxtwitter')).toBe(true)
    expect(isAllowedResolveUrl(url, 'auto')).toBe(true)
  })
})

describe('getJson — refusals happen before any request', () => {
  it('never calls fetch for a hostile host (DA10)', async () => {
    const fetchImpl = fakeFetch([])
    const client = createDlClient({ fetchImpl, fallback: 'off' })
    await expect(
      client.getJson('https://evil.example/x.com/a/status/1750123456789012352')
    ).rejects.toMatchObject({ code: 'URL_UNRECOGNIZED' })
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('never calls fetch for api.fxtwitter.com when the fallback is off', async () => {
    const fetchImpl = fakeFetch([])
    const client = createDlClient({ fetchImpl, fallback: 'off' })
    await expect(client.getJson('https://api.fxtwitter.com/status/1')).rejects.toMatchObject({
      code: 'URL_UNRECOGNIZED'
    })
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('refuses a plaintext media URL before any request (AUDIT A11)', async () => {
    const fetchImpl = fakeFetch([])
    const client = createDlClient({ fetchImpl, fallback: 'off' })
    await expect(
      client.streamTo('http://video.twimg.com/a.mp4', 'C:\\tmp\\a.part', {
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: 'URL_UNRECOGNIZED' })
    expect(fetchImpl.calls).toHaveLength(0)
  })
})

describe('getJson — status mapping', () => {
  it('returns the parsed JSON on 200', async () => {
    const client = createDlClient({
      fetchImpl: fakeFetch([{ match: 'cdn.syndication', respond: () => jsonResponse({ ok: 1 }) }]),
      fallback: 'off'
    })
    await expect(
      client.getJson('https://cdn.syndication.twimg.com/tweet-result?id=1')
    ).resolves.toEqual({
      ok: 1
    })
  })

  it('maps 404/401/403/429/5xx to typed codes', async () => {
    for (const [status, code] of [
      [404, 'NOT_FOUND'],
      [401, 'AUTH_REQUIRED'],
      [403, 'AUTH_REQUIRED'],
      [429, 'RATE_LIMITED'],
      [500, 'UPSTREAM_ERROR'],
      [503, 'UPSTREAM_ERROR']
    ] as const) {
      const client = createDlClient({
        fetchImpl: fakeFetch([
          { match: 'cdn.syndication', respond: () => new Response(null, { status }) }
        ]),
        fallback: 'off'
      })
      await expect(
        client.getJson('https://cdn.syndication.twimg.com/tweet-result?id=1')
      ).rejects.toMatchObject({
        code
      })
    }
  })

  it('carries Retry-After on a 429 (seconds form)', async () => {
    const client = createDlClient({
      fetchImpl: fakeFetch([
        {
          match: 'cdn.syndication',
          respond: () => new Response(null, { status: 429, headers: { 'retry-after': '7' } })
        }
      ]),
      fallback: 'off'
    })
    await expect(
      client.getJson('https://cdn.syndication.twimg.com/tweet-result?id=1')
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 7000 })
  })

  it('maps invalid JSON to UPSTREAM_ERROR', async () => {
    const client = createDlClient({
      fetchImpl: fakeFetch([
        { match: 'cdn.syndication', respond: () => new Response('not json{', { status: 200 }) }
      ]),
      fallback: 'off'
    })
    await expect(
      client.getJson('https://cdn.syndication.twimg.com/tweet-result?id=1')
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' })
  })

  it('maps a transport failure to NETWORK', async () => {
    const client = createDlClient({
      fetchImpl: fakeFetch([
        {
          match: 'cdn.syndication',
          respond: () => {
            throw new TypeError('fetch failed')
          }
        }
      ]),
      fallback: 'off'
    })
    await expect(
      client.getJson('https://cdn.syndication.twimg.com/tweet-result?id=1')
    ).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('a timeout is NETWORK, not a cancel', async () => {
    const client = createDlClient({
      fetchImpl: fakeFetch([
        {
          match: 'cdn.syndication',
          respond: () => {
            throw new DOMException('The operation timed out.', 'TimeoutError')
          }
        }
      ]),
      fallback: 'off'
    })
    await expect(
      client.getJson('https://cdn.syndication.twimg.com/tweet-result?id=1')
    ).rejects.toMatchObject({ code: 'NETWORK' })
  })

  it('a caller abort stays an AbortError so the run can mark it cancelled', async () => {
    const controller = new AbortController()
    const client = createDlClient({
      fetchImpl: fakeFetch([
        {
          match: 'cdn.syndication',
          respond: () => {
            controller.abort()
            throw new DOMException('The operation was aborted.', 'AbortError')
          }
        }
      ]),
      fallback: 'off'
    })
    await expect(
      client.getJson('https://cdn.syndication.twimg.com/tweet-result?id=1', {
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('expandTco', () => {
  it('reads the Location header without following it', async () => {
    const fetchImpl = fakeFetch([
      {
        match: 'https://t.co/',
        respond: () =>
          new Response(null, {
            status: 301,
            headers: { location: 'https://x.com/someuser/status/1750123456789012352' }
          })
      }
    ])
    const client = createDlClient({ fetchImpl, fallback: 'off' })
    await expect(client.expandTco('https://t.co/abc123')).resolves.toBe(
      'https://x.com/someuser/status/1750123456789012352'
    )
    expect(fetchImpl.calls[0]?.method).toBe('GET')
    // redirect: 'manual' — undici would have followed otherwise.
    expect(fetchImpl.calls).toHaveLength(1)
  })

  it('refuses a non-t.co link', async () => {
    const fetchImpl = fakeFetch([])
    const client = createDlClient({ fetchImpl, fallback: 'off' })
    await expect(client.expandTco('https://x.com/a/status/1')).rejects.toMatchObject({
      code: 'URL_UNRECOGNIZED'
    })
    expect(fetchImpl.calls).toHaveLength(0)
  })

  it('fails honestly when there is no Location', async () => {
    const client = createDlClient({
      fetchImpl: fakeFetch([
        { match: 'https://t.co/', respond: () => new Response(null, { status: 200 }) }
      ]),
      fallback: 'off'
    })
    await expect(client.expandTco('https://t.co/abc123')).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR'
    })
  })

  it('maps a 404 short link to NOT_FOUND', async () => {
    const client = createDlClient({
      fetchImpl: fakeFetch([
        { match: 'https://t.co/', respond: () => new Response(null, { status: 404 }) }
      ]),
      fallback: 'off'
    })
    await expect(client.expandTco('https://t.co/abc123')).rejects.toMatchObject({
      code: 'NOT_FOUND'
    })
  })
})

describe('header helpers', () => {
  it('parseRetryAfter understands seconds, floats and HTTP-dates', () => {
    const now = Date.parse('2026-10-20T12:00:00Z')
    expect(parseRetryAfter('30', now)).toBe(30_000)
    expect(parseRetryAfter('1.5', now)).toBe(1500)
    expect(parseRetryAfter('0', now)).toBe(0)
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', now)).toBe(
      Date.parse('2026-10-21T07:28:00Z') - now
    )
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter('', now)).toBeNull()
    expect(parseRetryAfter('later', now)).toBeNull()
    expect(parseRetryAfter('-5', now)).toBeNull()
  })

  it('contentRangeTotal reads both 206 and 416 shapes', () => {
    expect(contentRangeTotal('bytes 200-1023/4096')).toBe(4096)
    expect(contentRangeTotal('bytes */4096')).toBe(4096)
    expect(contentRangeTotal('bytes 0-99/*')).toBeNull()
    expect(contentRangeTotal(null)).toBeNull()
    expect(contentRangeTotal('garbage')).toBeNull()
  })
})

describe('probeStatus', () => {
  it('returns the status and follows at most one redirect', async () => {
    const fetchImpl = fakeFetch([
      {
        match: 'publish.twitter.com/oembed',
        respond: () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://publish.twitter.com/other' }
          })
      },
      {
        match: 'https://publish.twitter.com/other',
        respond: () => new Response(null, { status: 200 })
      }
    ])
    const client = createDlClient({ fetchImpl, fallback: 'off' })
    await expect(client.probeStatus('https://publish.twitter.com/oembed?url=x')).resolves.toBe(200)
    expect(fetchImpl.calls).toHaveLength(2)
  })

  it('is allow-listed like any resolve request', async () => {
    const fetchImpl = fakeFetch([])
    const client = createDlClient({ fetchImpl, fallback: 'off' })
    await expect(client.probeStatus('https://evil.example/oembed')).rejects.toBeInstanceOf(DlError)
    expect(fetchImpl.calls).toHaveLength(0)
  })
})
