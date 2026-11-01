import { DlError } from '../../../shared/downloader/errors'
import { isAllowedMediaUrl } from '../../../shared/downloader/urls'
import type { MediaAsset, ResolvedTweet, TweetRef, Variant } from '../../../shared/downloader/types'
import type { ResolveCtx } from './ctx'
import { asArray, asFiniteNumber, asRecord, asString, toIsoTimestamp } from './ctx'

/** oginstagram exposes public posts as ActivityStreams. Each indexed request
 * returns one attachment; the first response advertises the carousel length. */
export class InstagramResolver {
  async resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet> {
    const code = ref.tweetId.slice(3)
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(code))
      throw new DlError('URL_UNRECOGNIZED', 'invalid Instagram shortcode')
    const get = async (index: number): Promise<Record<string, unknown>> => {
      ctx.onRequest?.()
      const value = await ctx.client.getJson(
        `https://oginstagram.com/p/${code}?img_index=${index}`,
        { signal: ctx.signal }
      )
      const record = asRecord(value)
      if (!record)
        throw new DlError('UPSTREAM_ERROR', 'Instagram proxy returned an invalid response')
      return record
    }
    const first = await get(1)
    const content = asString(first.content) ?? ''
    // Indexed carousel responses include a position marker such as "1 / 10".
    const marker = /(?:^|>)\s*[^<]*?\b1\s*\/\s*(\d+)\b/.exec(content)
    const count = marker ? Number(marker[1]) : 1
    if (!Number.isInteger(count) || count < 1 || count > 20)
      throw new DlError('UPSTREAM_ERROR', 'Invalid Instagram carousel size')
    const media: MediaAsset[] = []
    for (let index = 1; index <= count; index += 1) {
      const data = index === 1 ? first : await get(index)
      const raw = asRecord(asArray(data.attachment)[0])
      const url = asString(raw?.url)
      const type = asString(raw?.mediaType)?.toLowerCase() ?? ''
      if (
        !url ||
        !isAllowedMediaUrl(url) ||
        !['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(type)
      ) {
        throw new DlError(
          'UPSTREAM_ERROR',
          `Instagram media ${index} is unavailable or unsupported`
        )
      }
      const width = asFiniteNumber(raw?.width)
      const height = asFiniteNumber(raw?.height)
      const variant: Variant = { url, contentType: type, width, height, bitrate: null }
      media.push({
        index,
        kind: type.startsWith('image/') ? 'photo' : 'video',
        variants: [variant],
        width,
        height,
        posterUrl: null
      })
    }
    const attribution = asString(first.attributedTo)
    let author = 'unknown'
    try {
      if (attribution)
        author = new URL(attribution).pathname.split('/').filter(Boolean)[0] ?? author
    } catch {
      /* optional metadata */
    }
    const caption = content
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim()
    return {
      ref,
      author: { screenName: author, displayName: null, verified: false },
      text: caption,
      createdAt: toIsoTimestamp(first.published),
      media,
      source: 'instagram'
    }
  }
}
