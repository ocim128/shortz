/**
 * Adapter B — `api.fxtwitter.com/status/<id>` (opt-in, Settings toggle).
 *
 * A third-party service: enabling it sends the URL to someone else's operator,
 * which is why the toggle's copy says exactly that. Mapping and error semantics:
 * technical/resolver-chain.md §4.
 *
 *  - One progressive MP4 per video → a single-variant ladder with
 *    `bitrate: null` (the payload has no ladder); `select.ts` then scores by
 *    pixel area, never NaN.
 *  - Photos are mapped as photo assets (reported, never downloaded).
 *  - A 404 here is a **non-primary** signal: the chain demotes it to
 *    NOT_EMBEDDABLE, because a third party must never be authoritative about
 *    deletion (AUDIT A1, DA11).
 */

import { DlError } from '../../../shared/downloader/errors'
import type {
  MediaAsset,
  MediaKind,
  ResolvedTweet,
  TweetRef,
  Variant
} from '../../../shared/downloader/types'
import type { ResolveCtx, Resolver } from './ctx'
import { asArray, asFiniteNumber, asRecord, asString, toIsoFromUnixSeconds, toIsoTimestamp } from './ctx'

export function fxTwitterUrl(tweetId: string): string {
  return `https://api.fxtwitter.com/status/${tweetId}`
}

function mapVideos(raw: Record<string, unknown>, startIndex: number): MediaAsset[] {
  const out: MediaAsset[] = []
  let index = startIndex
  for (const entry of asArray(raw.videos)) {
    const video = asRecord(entry)
    if (video === null) continue
    const url = asString(video.url)
    if (url === null) continue
    const width = asFiniteNumber(video.width)
    const height = asFiniteNumber(video.height)
    const kind: MediaKind = asString(video.type) === 'gif' ? 'gif' : 'video'
    const variant: Variant = {
      url,
      bitrate: null,
      contentType: 'video/mp4',
      width,
      height
    }
    index += 1
    out.push({
      index,
      kind,
      variants: [variant],
      width,
      height,
      posterUrl: asString(video.thumbnail_url)
    })
  }
  return out
}

function mapPhotos(raw: Record<string, unknown>, startIndex: number): MediaAsset[] {
  const out: MediaAsset[] = []
  let index = startIndex
  for (const entry of asArray(raw.photos)) {
    const photo = asRecord(entry)
    if (photo === null) continue
    index += 1
    out.push({
      index,
      kind: 'photo',
      variants: [],
      width: asFiniteNumber(photo.width),
      height: asFiniteNumber(photo.height),
      posterUrl: asString(photo.url)
    })
  }
  return out
}

/** The payload mapping; exported for the fixture table tests. */
export function mapFxTwitterPayload(ref: TweetRef, payload: unknown): ResolvedTweet {
  const root = asRecord(payload)
  const tweet = asRecord(root?.tweet)
  if (tweet === null) {
    // "missing tweet object → NOT_FOUND (same demotion)" — the chain demotes it.
    throw new DlError('NOT_FOUND', 'no tweet object in the fxtwitter payload')
  }

  const id = asString(tweet.id)
  if (id !== null && id !== ref.tweetId) {
    throw new DlError('UPSTREAM_ERROR', `payload id ${id} does not match ${ref.tweetId}`)
  }

  const author = asRecord(tweet.author)
  const screenName = asString(author?.screen_name) ?? ref.screenName ?? 'unknown'
  const media = asRecord(tweet.media)
  const videos = media === null ? [] : mapVideos(media, 0)
  const photos = media === null ? [] : mapPhotos(media, videos.length)

  const createdAt = toIsoTimestamp(tweet.created_at) ?? toIsoFromUnixSeconds(tweet.created_timestamp)

  return {
    ref: { tweetId: ref.tweetId, screenName, canonicalUrl: ref.canonicalUrl },
    author: {
      screenName,
      displayName: asString(author?.name),
      verified: author?.verified === true
    },
    text: asString(tweet.text) ?? '',
    createdAt,
    media: [...videos, ...photos],
    source: 'fxtwitter'
  }
}

export class FxTwitterResolver implements Resolver {
  readonly name = 'fxtwitter' as const

  async resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet> {
    ctx.onRequest?.()
    const payload = await ctx.client.getJson(fxTwitterUrl(ref.tweetId), { signal: ctx.signal })
    return mapFxTwitterPayload(ref, payload)
  }
}
