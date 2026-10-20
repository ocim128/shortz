/**
 * The cross-tier downloader contract (OWNER: Agent A — additive changes only).
 *
 * Pure types: no `node:`, no DOM, no Electron. Imported by the renderer
 * (preview + row map), the main process (IPC glue), the core orchestrator, the
 * CLI and Vitest. The event shapes below are what the renderer's row map keys
 * off — `key` is stable per physical textarea line (`line-<n>`), never an index
 * into a filtered list, so a malformed or duplicate line cannot shift rows.
 */

export type ResolverName = 'syndication' | 'fxtwitter' | 'ytdlp'

export interface TweetRef {
  tweetId: string
  screenName: string | null
  /** 'https://x.com/<user|i>/status/<id>' — every adapter and the UI display this. */
  canonicalUrl: string
}

export interface Author {
  screenName: string
  displayName: string | null
  verified: boolean
}

export type MediaKind = 'video' | 'gif' | 'photo' | 'unknown'

export interface Variant {
  url: string
  /** bits per second, or null when the adapter cannot say (fxtwitter). */
  bitrate: number | null
  contentType: string | null
  width: number | null
  height: number | null
}

export interface MediaAsset {
  /** 1-based position in the post. */
  index: number
  kind: MediaKind
  variants: Variant[]
  width: number | null
  height: number | null
  posterUrl: string | null
}

export interface ResolvedTweet {
  ref: TweetRef
  author: Author
  text: string
  /** ISO 8601, or null when no usable timestamp was available. */
  createdAt: string | null
  media: MediaAsset[]
  source: ResolverName
}

export interface Chosen {
  /** === media.index (1-based). */
  index: number
  media: MediaAsset
  variant: Variant
}

export type DlQuality = 'best' | 'worst' | { maxHeight: number }

export type DlErrorCode =
  | 'URL_UNRECOGNIZED'
  | 'TWEET_ID_INVALID'
  | 'NOT_EMBEDDABLE'
  | 'NOT_FOUND'
  | 'AUTH_REQUIRED'
  | 'NO_VIDEO'
  | 'RATE_LIMITED'
  | 'LINK_EXPIRED'
  | 'UPSTREAM_ERROR'
  | 'NETWORK'
  | 'INTEGRITY_MISMATCH'
  | 'DISK_FULL'
  | 'WRITE_ERROR'
  | 'CANCELLED'
  | 'UNEXPECTED'

export type DlItemStatus =
  | 'queued'
  | 'resolving'
  | 'planned'
  | 'skipped'
  | 'downloading'
  | 'ok'
  | 'partial'
  | 'failed'
  | 'cancelled'

export type DlSkipReason = 'already-downloaded' | 'duplicate' | 'circuit-open'

// ---------------- request ----------------
export interface DlInput {
  /** 'line-<lineNumber>' from parseRunInput(); echoed on every event for this line. */
  key: string
  /** 1-based physical textarea line number. */
  lineNumber: number
  /** The line text exactly as typed (trimmed). */
  text: string
}

export interface DlRequest {
  /** EVERY line, duplicates and junk included. One verdict per line, always. */
  inputs: DlInput[]
  quality?: DlQuality
  outputDir?: string
  force?: boolean
  /** Analyze: resolve + select + plan + lazy posters. No media writes, no state writes. */
  dryRun?: boolean
  /** 'Retry failed': items come from the state index; inputs may legitimately be []. */
  retryFailed?: true
}

// ---------------- events: core -> main. Codes, never sentences. ----------------
export interface DlMediaState {
  index: number
  status: DlItemStatus
  bytes: number
  total: number | null
}

export interface DlItemEvent {
  jobId: string
  kind: 'item'
  key: string
  lineNumber: number
  /** 0-based position among the run's items; equals `total` on the run-done event. */
  index: number
  total: number
  item: {
    tweetId: string
    status: DlItemStatus
    author?: string
    caption?: string
    /** Absolute path of the poster the core cached, when it fetched one. */
    localPosterPath?: string
    /** Planned absolute paths (planned / ok / partial). */
    plannedPaths?: string[]
    /** Final absolute paths (ok / partial only). */
    files?: string[]
    errorCode?: DlErrorCode
    /** Raw detail for the log/tooltip. Never the primary user sentence. */
    errorDetail?: string
    skipReason?: DlSkipReason
    media?: DlMediaState[]
  }
}

export interface DlMediaProgressEvent {
  jobId: string
  kind: 'media-progress'
  key: string
  lineNumber: number
  /** 0-based position among the run's items. */
  index: number
  /** The run's item count. (v1 erratum: the frozen text declared `total` twice
   * in this interface — a duplicate key that cannot compile. The byte total
   * keeps the name, matching `DlMediaState.total`, and the item count is
   * `itemTotal`.) */
  itemTotal: number
  mediaIndex: number
  bytes: number
  total: number | null
}

export interface DlRunDoneEvent {
  jobId: string
  kind: 'run-done'
  total: number
  summary: { ok: number; skipped: number; partial: number; failed: number; cancelled: number }
  cancelled: boolean
}

export type DlEvent = DlItemEvent | DlMediaProgressEvent | DlRunDoneEvent

export interface DlRunSummary {
  jobId: string
  total: number
  ok: number
  skipped: number
  partial: number
  failed: number
  cancelled: boolean
}

// ---------------- history (dlList) ----------------
export interface DlListEntry {
  tweetId: string
  author: string | null
  caption: string
  /** Filled by MAIN (mintMediaUrl). The core never sets it. */
  posterMediaUrl?: string
  files: { path: string; sizeBytes: number; mediaIndex: number }[]
  /** Derived from media rows: some ok + some failed => 'partial'. Never stored. */
  status: 'ok' | 'partial' | 'failed'
  downloadedAt: string
}
