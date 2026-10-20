/**
 * Adapter A — `cdn.syndication.twimg.com/tweet-result` (always on).
 *
 * The endpoint react-tweet ships to millions of pages: no account, no key, the
 * computed token in the query string. Mapping and status semantics are
 * normative in docs/twitter-downloader/technical/resolver-chain.md §3; the parts
 * that matter:
 *
 *  - A 404, a tombstone, or a payload without `mediaDetails` is
 *    **NOT_EMBEDDABLE, never NOT_FOUND**: this endpoint cannot tell "deleted"
 *    from "sensitive", and only the primary adapter or the failure-path probe may
 *    say a post is gone (AUDIT A1).
 *  - `created_at` accepts ISO 8601 and Twitter's `Wed Oct 22 … +0000 2020` form;
 *    an unparseable timestamp is UPSTREAM_ERROR.
 *  - `mediaDetails[].video_info.variants[]` becomes the variant ladder, with the
 *    asset's dimensions copied onto each variant so `maxHeight` selection works
 *    even though the payload only carries dims at the asset level.
 */

import { DlError } from '../../../shared/downloader/errors'
import { syndicationToken } from '../../../shared/downloader/token'
import type {
  MediaAsset,
  MediaKind,
  ResolvedTweet,
  TweetRef,
  Variant
} from '../../../shared/downloader/types'
import type { ResolveCtx, Resolver } from './ctx'
import { asArray, asFiniteNumber, asRecord, asString, toIsoTimestamp } from './ctx'

/**
 * Pinned once, captured from react-tweet's `fetch-tweet.ts` (live-verified in
 * xdl). Drifts upstream → stored, never modeled.
 */
export const SYNDICATION_FEATURES =
  'tfw_timeline_list:;tfw_follower_count_sunset:true;tfw_tweet_edit_backend:on;tfw_refsrc_session:on;tfw_show_blue_verified_badge:on;tfw_legacy_timeline_sunset:true;tfw_show_gov_verified_badge:on;tfw_show_business_affiliate_badge:on;tfw_tweet_edit_frontend:on'

export function syndicationUrl(tweetId: string): string {
  const token = syndicationToken(tweetId)
  const params = new URLSearchParams({
    id: tweetId,
    lang: 'en',
    token,
    features: SYNDICATION_FEATURES
  })
  return `https://cdn.syndication.twimg.com/tweet-result?${params.toString()}`
}

function kindOf(raw: Record<string, unknown>): MediaKind {
  const type = asString(raw.type)
  if (type === 'video') return 'video'
  if (type === 'animated_gif') return 'gif'
  if (type === 'photo') return 'photo'
  return 'unknown'
}

function dimensionsOf(raw: Record<string, unknown>): {
  width: number | null
  height: number | null
} {
  const original = asRecord(raw.original_info)
  const fromOriginal =
    original === null
      ? { width: null, height: null }
      : { width: asFiniteNumber(original.width), height: asFiniteNumber(original.height) }
  if (fromOriginal.width !== null && fromOriginal.height !== null) return fromOriginal
  const large = asRecord(asRecord(raw.sizes)?.large)
  if (large !== null) {
    const width = asFiniteNumber(large.w)
    const height = asFiniteNumber(large.h)
    if (width !== null && height !== null) return { width, height }
  }
  return fromOriginal
}

function variantsOf(
  raw: Record<string, unknown>,
  width: number | null,
  height: number | null
): Variant[] {
  const videoInfo = asRecord(raw.video_info)
  if (videoInfo === null) return []
  const out: Variant[] = []
  for (const entry of asArray(videoInfo.variants)) {
    const variant = asRecord(entry)
    if (variant === null) continue
    const url = asString(variant.url)
    if (url === null) continue
    out.push({
      url,
      bitrate: asFiniteNumber(variant.bitrate),
      contentType: asString(variant.content_type),
      width,
      height
    })
  }
  return out
}

function mapMedia(raw: Record<string, unknown>, index: number): MediaAsset {
  const kind = kindOf(raw)
  const { width, height } = dimensionsOf(raw)
  return {
    index,
    kind,
    variants: kind === 'photo' ? [] : variantsOf(raw, width, height),
    width,
    height,
    posterUrl: asString(raw.media_url_https)
  }
}

/** The `_map_payload` port; exported for the fixture table tests. */
export function mapSyndicationPayload(ref: TweetRef, payload: unknown): ResolvedTweet {
  const root = asRecord(payload)
  if (root === null) throw new DlError('NOT_EMBEDDABLE', 'empty payload')

  const typename = asString(root.__typename)
  if (typename === 'TweetTombstone') {
    throw new DlError('NOT_EMBEDDABLE', 'tombstone (withheld by the endpoint)')
  }

  const idStr = asString(root.id_str)
  if (idStr !== null && idStr !== ref.tweetId) {
    throw new DlError('UPSTREAM_ERROR', `payload id ${idStr} does not match ${ref.tweetId}`)
  }

  const mediaRaw = asArray(root.mediaDetails)
  if (mediaRaw.length === 0) {
    // Syndication strips media on sensitive posts too, so "no media" is only
    // trustworthy from the final adapter (xdl round-2 rule).
    throw new DlError('NOT_EMBEDDABLE', 'no mediaDetails')
  }

  const user = asRecord(root.user)
  const screenName = asString(user?.screen_name) ?? ref.screenName ?? 'unknown'

  const createdRaw = root.created_at
  const createdAt = toIsoTimestamp(createdRaw)
  if (createdAt === null && createdRaw !== undefined && createdRaw !== null) {
    throw new DlError('UPSTREAM_ERROR', `unparseable created_at: ${String(createdRaw)}`)
  }

  const media: MediaAsset[] = []
  let index = 0
  for (const entry of mediaRaw) {
    const raw = asRecord(entry)
    if (raw === null) continue
    index += 1
    media.push(mapMedia(raw, index))
  }
  if (media.length === 0) throw new DlError('UPSTREAM_ERROR', 'mediaDetails had no usable entries')

  return {
    ref: { tweetId: ref.tweetId, screenName, canonicalUrl: ref.canonicalUrl },
    author: {
      screenName,
      displayName: asString(user?.name),
      verified: user?.verified === true
    },
    text: asString(root.text) ?? '',
    createdAt,
    media,
    source: 'syndication'
  }
}

export class SyndicationResolver implements Resolver {
  readonly name = 'syndication' as const

  async resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet> {
    ctx.onRequest?.()
    let payload: unknown
    try {
      payload = await ctx.client.getJson(syndicationUrl(ref.tweetId), { signal: ctx.signal })
    } catch (error) {
      // The client maps 404 to NOT_FOUND generically; for THIS endpoint a 404
      // means "won't tell us", never "deleted" (AUDIT A1).
      if (error instanceof DlError && error.code === 'NOT_FOUND') {
        throw new DlError('NOT_EMBEDDABLE', 'syndication 404 (deleted, sensitive or fresh)')
      }
      throw error
    }
    return mapSyndicationPayload(ref, payload)
  }
}
