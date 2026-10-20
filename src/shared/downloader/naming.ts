/**
 * Deterministic, Windows-safe download paths (docs/twitter-downloader/technical/
 * storage-naming.md §2).
 *
 * **Pure** — no `node:path`: the repo's unit tests also run on Linux, where an
 * absolute path built here would diverge from the one Windows produces. So this
 * module returns the *pieces* ({@link PlannedPath}), the core composes the real
 * path with `path.join(root, ...dirSegments, fileName)`, and the renderer shows
 * `relativePath` (backslash-joined, display only). See NOTES-A D-A1.
 *
 * The same post always maps to the same path: skip checks, resume and the
 * renderer's preview all depend on it.
 */

import { sanitizeSegment } from '../naming'
import type { TweetRef } from './types'

export type DlLayout = 'by-author' | 'by-date' | 'flat'

/** Default filename template (settings). */
export const DEFAULT_FILENAME_TEMPLATE = '{id}'

/** The fixed marker segment that namespaces downloads inside the user's folder. */
export const ROOT_SEGMENT = 'x'

/** Media extension produced by the MVP (D5 may add others). */
export const MEDIA_EXTENSION = '.mp4'

/** Windows total-path budget: root + separators + segments + file name (AUDIT A14). */
export const MAX_RELATIVE_PATH = 240

/** `{slug}` cap, in characters. */
export const MAX_SLUG_LENGTH = 30

export interface NamingTweet {
  tweetId: string
  author: string | null
  createdAt: string | null
  text: string
}

export interface PlannedPath {
  /** Segments below the output root, always starting with the fixed `x` marker. */
  dirSegments: string[]
  /** File name including `.mp4`. */
  fileName: string
  /** Display-only, backslash-joined path relative to the output root. */
  relativePath: string
}

export interface RenderPlannedPathArgs {
  tweet: NamingTweet
  /** 1-based media position in the post (`_v2` suffix from index 2 on). */
  mediaIndex: number
  layout: DlLayout
  filenameTemplate: string
  /** Characters already consumed by the output root plus its separator. */
  rootLength: number
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/** `{date}` is the POST's date in local time — a batch downloaded today stays grouped by posting. */
export function dateParts(
  createdAt: string | null,
  now: Date = new Date()
): { yyyy: string; mm: string; date: string } {
  const parsed = createdAt === null ? null : new Date(createdAt)
  const date = parsed !== null && !Number.isNaN(parsed.getTime()) ? parsed : now
  const yyyy = String(date.getFullYear())
  const mm = pad2(date.getMonth() + 1)
  return { yyyy, mm, date: `${yyyy}-${mm}-${pad2(date.getDate())}` }
}

/**
 * `{slug}`: lowercase ASCII, runs of anything else collapse to `-`, trimmed, ≤ 30.
 * Emoji/CJK captions degrade to `-` runs that collapse away — never to a broken path.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
}

/** Separators a template can leave dangling when a token renders empty. */
function stripTrailingJunk(value: string): string {
  return value.replace(/[-_. ]+$/, '')
}

function renderTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in tokens ? (tokens[name] as string) : whole
  )
}

/**
 * Render one media file's planned path.
 *
 * The 240-char budget (AUDIT A14) is enforced by shrinking the *variable* parts —
 * the author folder first, then the slug — and never the tweet id, which is the
 * canonical key. A pathological template that still does not fit falls back to
 * the id-only name.
 */
export function renderPlannedPath(args: RenderPlannedPathArgs): PlannedPath {
  const { tweet, mediaIndex, layout, filenameTemplate, rootLength } = args
  const parts = dateParts(tweet.createdAt)
  const slug = slugify(tweet.text)
  const stemBudget = 120 - MEDIA_EXTENSION.length

  const build = (authorValue: string, slugValue: string, template: string): PlannedPath => {
    const tokens: Record<string, string> = {
      id: tweet.tweetId,
      date: parts.date,
      author: authorValue,
      index: String(mediaIndex),
      slug: slugValue
    }
    let stem = renderTemplate(template, tokens)
    // `_v{n}` only when the template did not consume `{index}` (AUDIT A21):
    // `{id}_{index}` must not produce `123_2_v2.mp4`.
    if (mediaIndex >= 2 && !template.includes('{index}')) stem = `${stem}_v${mediaIndex}`
    stem = stripTrailingJunk(stem)
    const safeStem = sanitizeSegment(stem, { maxLength: stemBudget })
    const fileName = `${safeStem}${MEDIA_EXTENSION}`

    let dirSegments: string[]
    switch (layout) {
      case 'by-date':
        dirSegments = [ROOT_SEGMENT, parts.yyyy, parts.mm]
        break
      case 'flat':
        dirSegments = [ROOT_SEGMENT]
        break
      case 'by-author':
      default:
        dirSegments = [
          ROOT_SEGMENT,
          sanitizeSegment(authorValue.length > 0 ? authorValue : 'unknown')
        ]
        break
    }
    return {
      dirSegments,
      fileName,
      relativePath: [...dirSegments, fileName].join('\\')
    }
  }

  const measure = (path: PlannedPath): number =>
    rootLength +
    path.dirSegments.reduce((total, segment) => total + segment.length + 1, 0) +
    path.fileName.length

  let authorValue = tweet.author ?? ''
  let slugValue = slug
  let planned = build(authorValue, slugValue, filenameTemplate)

  while (measure(planned) > MAX_RELATIVE_PATH && authorValue.length > 1) {
    authorValue = authorValue.slice(0, -1)
    planned = build(authorValue, slugValue, filenameTemplate)
  }
  while (measure(planned) > MAX_RELATIVE_PATH && slugValue.length > 0) {
    slugValue = slugValue.slice(0, -1).replace(/-+$/, '')
    planned = build(authorValue, slugValue, filenameTemplate)
  }
  if (measure(planned) > MAX_RELATIVE_PATH) {
    planned = build(authorValue, '', '{id}')
  }
  return planned
}

/** The absolute path the core writes, from the pure pieces plus the real root. */
export function joinPlannedPath(root: string, planned: PlannedPath, separator: string): string {
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  return [trimmedRoot, ...planned.dirSegments, planned.fileName].join(separator)
}

/** Convenience for callers that only have a ref (state rows, retry-failed). */
export function tweetFromRef(ref: TweetRef, extra: Partial<NamingTweet> = {}): NamingTweet {
  return {
    tweetId: ref.tweetId,
    author: extra.author ?? ref.screenName,
    createdAt: extra.createdAt ?? null,
    text: extra.text ?? ''
  }
}
