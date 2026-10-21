/**
 * The state index — `<dataDir>/downloads/state.json`, schema v2
 * (storage-naming.md §4).
 *
 * One JSON document, mutated at item boundaries and flushed atomically, so a
 * crash can lose bookkeeping but never corrupt media. The two rules that make
 * idempotence real:
 *
 *  - **Completeness** = `ok rows === mediaCount` AND every `filePath` stats as a
 *    file. Never "a row exists": a multi-video post with one failed video is
 *    incomplete and does not skip.
 *  - **`mediaCount` counts downloadable media only**, and the tweet row is
 *    written only after selection succeeded — a photo-only post must never anchor
 *    `mediaCount = 0`, which would make every re-run a false skip.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DlListEntry, DlRunSummary, ResolverName } from '../../../shared/downloader/types'
import { atomicWriteFile } from '../../store/fs-utils'

export const STATE_SCHEMA_VERSION = 2

export interface StateTweetRow {
  author: string | null
  caption: string
  url: string
  mediaCount: number
  firstSeen: string
}

export interface StateRunRow {
  startedAt: string
  finishedAt: string | null
  total: number
  ok: number
  skipped: number
  partial: number
  failed: number
  cancelled?: boolean
}

export interface StateDownloadRow {
  filePath: string
  sizeBytes: number
  status: 'ok' | 'failed'
  error: string | null
  source: ResolverName
  runId: string
  downloadedAt: string
  updatedAt: string
}

export interface StateDoc {
  schemaVersion: number
  tweets: Record<string, StateTweetRow>
  runs: Record<string, StateRunRow>
  downloads: Record<string, StateDownloadRow>
}

export function downloadKey(tweetId: string, mediaIndex: number): string {
  return `${tweetId}:${mediaIndex}`
}

function emptyDoc(): StateDoc {
  return { schemaVersion: STATE_SCHEMA_VERSION, tweets: {}, runs: {}, downloads: {} }
}

/** Defensive read: a partial/corrupt document must never crash the app. */
function coerceDoc(parsed: unknown): StateDoc | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (record.schemaVersion !== STATE_SCHEMA_VERSION) return null
  const tweets = record.tweets
  const downloads = record.downloads
  if (typeof tweets !== 'object' || tweets === null) return null
  if (typeof downloads !== 'object' || downloads === null) return null
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    tweets: tweets as Record<string, StateTweetRow>,
    runs: (typeof record.runs === 'object' && record.runs !== null ? record.runs : {}) as Record<
      string,
      StateRunRow
    >,
    downloads: downloads as Record<string, StateDownloadRow>
  }
}

export class StateStore {
  private doc: StateDoc
  private tail: Promise<void> = Promise.resolve()
  /**
   * Per-tweet view of `doc.downloads`, maintained incrementally. Without it,
   * `downloadsOf`/`listEntries`/`retryTargets` were O(tweets × downloads) on the
   * main thread (measured: 11.7 s for a 4 000-post library) because each lookup
   * scanned every download key.
   */
  private readonly byTweet = new Map<string, Map<number, StateDownloadRow>>()
  /** True while a flush task is queued/in flight — concurrent flushes coalesce. */
  private writePending = false
  /** Set by every mutation + flush; the write loop consumes it. */
  private dirty = false
  /** Pending trailing write scheduled by `flushSoon()`. */
  private soonTimer: ReturnType<typeof setTimeout> | null = null

  private constructor(
    private readonly filePath: string,
    doc: StateDoc
  ) {
    this.doc = doc
    for (const [key, row] of Object.entries(doc.downloads)) {
      const at = key.lastIndexOf(':')
      if (at <= 0) continue
      const tweetId = key.slice(0, at)
      const mediaIndex = Number.parseInt(key.slice(at + 1), 10)
      if (!Number.isFinite(mediaIndex)) continue
      let media = this.byTweet.get(tweetId)
      if (media === undefined) {
        media = new Map()
        this.byTweet.set(tweetId, media)
      }
      media.set(mediaIndex, row)
    }
  }

  /** Path of the state file (the CLI prints it; main does not need to care). */
  get path(): string {
    return this.filePath
  }

  /**
   * Open (or create) the index. Throws when the data directory cannot be created
   * or read — a caller bug the run must reject before its first event (D-A7).
   */
  static async open(dataDir: string): Promise<StateStore> {
    const dir = path.join(dataDir, 'downloads')
    await fs.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, 'state.json')

    let raw: string | null = null
    try {
      raw = await fs.readFile(filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (raw === null) return new StateStore(filePath, emptyDoc())

    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
      const doc = coerceDoc(JSON.parse(text))
      if (doc === null) throw new Error('unexpected state schema')
      return new StateStore(filePath, doc)
    } catch {
      // Quarantine and rebuild empty: the files on disk are the source of truth
      // and are re-finalized by the next resolve (storage-naming.md §4).
      const quarantine = path.join(dir, `state.corrupt-${Date.now()}.json`)
      await fs.rename(filePath, quarantine).catch(() => undefined)
      return new StateStore(filePath, emptyDoc())
    }
  }

  /** The raw rows (a copy — callers must not mutate the document). */
  tweet(tweetId: string): StateTweetRow | null {
    return this.doc.tweets[tweetId] ?? null
  }

  downloadsOf(tweetId: string): StateDownloadRow[] {
    return [...(this.byTweet.get(tweetId)?.values() ?? [])]
  }

  /** Every tweet id the index knows, in first-seen order. */
  tweetIds(): string[] {
    return Object.keys(this.doc.tweets)
  }

  /**
   * The completeness rule of storage-naming.md §4: `ok` rows === mediaCount AND
   * every file stats. A error here must not skip: it returns false.
   */
  async isComplete(tweetId: string): Promise<boolean> {
    const tweet = this.tweet(tweetId)
    if (tweet === null || tweet.mediaCount <= 0) return false
    const rows = this.downloadsOf(tweetId).filter((row) => row.status === 'ok')
    if (rows.length !== tweet.mediaCount) return false
    for (const row of rows) {
      const ok = await fs
        .stat(row.filePath)
        .then((stat) => stat.isFile() && stat.size > 0)
        .catch(() => false)
      if (!ok) return false
    }
    return true
  }

  /** Newest first, capped. `posterMediaUrl` is main's job, never the core's. */
  listEntries(limit: number): DlListEntry[] {
    const entries: DlListEntry[] = []
    for (const [tweetId, tweet] of Object.entries(this.doc.tweets)) {
      const media = this.byTweet.get(tweetId)
      if (media === undefined || media.size === 0) continue
      const rows = [...media.entries()].map(([mediaIndex, row]) => ({ mediaIndex, row }))

      const okRows = rows.filter((entry) => entry.row.status === 'ok')
      const hasFailed = rows.some((entry) => entry.row.status === 'failed')
      const status: DlListEntry['status'] =
        okRows.length > 0 && (hasFailed || okRows.length < tweet.mediaCount)
          ? 'partial'
          : okRows.length > 0
            ? 'ok'
            : 'failed'
      const newest = rows
        .map((entry) => entry.row.downloadedAt)
        .sort()
        .reverse()[0]

      entries.push({
        tweetId,
        author: tweet.author,
        caption: tweet.caption,
        files: okRows
          .map((entry) => ({
            path: entry.row.filePath,
            sizeBytes: entry.row.sizeBytes,
            mediaIndex: entry.mediaIndex
          }))
          .sort((a, b) => a.mediaIndex - b.mediaIndex),
        status,
        downloadedAt: newest ?? tweet.firstSeen
      })
    }
    entries.sort((a, b) =>
      a.downloadedAt < b.downloadedAt ? 1 : a.downloadedAt > b.downloadedAt ? -1 : 0
    )
    return entries.slice(0, Math.max(0, limit))
  }

  /** Tweet ids whose last run left them failed or incomplete (D-A6, retry-failed). */
  retryTargets(): string[] {
    const out: string[] = []
    for (const [tweetId, tweet] of Object.entries(this.doc.tweets)) {
      const rows = this.byTweet.get(tweetId)
      if (rows === undefined) {
        if (tweet.mediaCount > 0) out.push(tweetId)
        continue
      }
      let okRows = 0
      let failed = false
      for (const row of rows.values()) {
        if (row.status === 'ok') okRows += 1
        else failed = true
      }
      if (failed || (tweet.mediaCount > 0 && okRows < tweet.mediaCount)) out.push(tweetId)
    }
    return out
  }

  /** Upsert the tweet row. `mediaCount` is the latest resolve's count. */
  noteTweet(args: {
    tweetId: string
    author: string | null
    caption: string
    url: string
    mediaCount: number
    at?: string
  }): void {
    const at = args.at ?? new Date().toISOString()
    const existing = this.doc.tweets[args.tweetId]
    this.doc.tweets[args.tweetId] = {
      author: args.author,
      caption: args.caption,
      url: args.url,
      mediaCount: args.mediaCount,
      firstSeen: existing?.firstSeen ?? at
    }
  }

  recordDownload(row: {
    tweetId: string
    mediaIndex: number
    filePath: string
    sizeBytes: number
    status: 'ok' | 'failed'
    error?: string | null
    source: ResolverName
    runId: string
    at?: string
  }): void {
    const at = row.at ?? new Date().toISOString()
    const key = downloadKey(row.tweetId, row.mediaIndex)
    const existing = this.doc.downloads[key]
    const stored: StateDownloadRow = {
      filePath: row.filePath,
      sizeBytes: row.sizeBytes,
      status: row.status,
      error: row.error ?? null,
      source: row.source,
      runId: row.runId,
      downloadedAt: row.status === 'ok' ? at : (existing?.downloadedAt ?? at),
      updatedAt: at
    }
    this.doc.downloads[key] = stored
    let media = this.byTweet.get(row.tweetId)
    if (media === undefined) {
      media = new Map()
      this.byTweet.set(row.tweetId, media)
    }
    media.set(row.mediaIndex, stored)
  }

  /** Forget a media row (a file that vanished, or a clean restart over it). */
  forgetDownload(tweetId: string, mediaIndex: number): void {
    delete this.doc.downloads[downloadKey(tweetId, mediaIndex)]
    const media = this.byTweet.get(tweetId)
    if (media === undefined) return
    media.delete(mediaIndex)
    if (media.size === 0) this.byTweet.delete(tweetId)
  }

  recordRun(summary: DlRunSummary, startedAt: string, finishedAt: string): void {
    this.doc.runs[summary.jobId] = {
      startedAt,
      finishedAt,
      total: summary.total,
      ok: summary.ok,
      skipped: summary.skipped,
      partial: summary.partial,
      failed: summary.failed,
      cancelled: summary.cancelled
    }
  }

  /** Full document snapshot (tests + diagnostics). */
  snapshot(): StateDoc {
    return JSON.parse(JSON.stringify(this.doc)) as StateDoc
  }

  /**
   * Schedule a trailing write instead of paying one now — used at item/media
   * boundaries, where blocking the transfer loop on a multi-MiB rewrite bought
   * nothing (a crash may lose ≤ delayMs of bookkeeping; media is untouched).
   * `flush()` still writes immediately when a caller needs a barrier.
   */
  flushSoon(delayMs = 250): void {
    this.dirty = true
    if (this.soonTimer !== null) return
    this.soonTimer = setTimeout(() => {
      this.soonTimer = null
      void this.flush().catch(() => undefined)
    }, delayMs)
    this.soonTimer.unref?.()
  }

  /**
   * Flush the document atomically. Concurrent calls COALESCE into one write:
   * the run flushes at every item and media boundary, and each flush used to
   * rewrite the whole (ever-growing) document — 1.68 GB written for a 200-item
   * run against a 2 MiB index. The write loop re-checks `dirty`, so mutations
   * that land while a write is in flight are never lost; `execute()`'s final
   * flush (awaited after `recordRun`) remains the durability barrier.
   *
   * Compact JSON: state.json is machine-only (the sidecar is the readable
   * artifact), and pretty-printing cost 26 % of the bytes on every write.
   */
  flush(): Promise<void> {
    if (this.soonTimer !== null) {
      clearTimeout(this.soonTimer)
      this.soonTimer = null
    }
    this.dirty = true
    if (this.writePending) return this.tail
    this.writePending = true
    const run = async (): Promise<void> => {
      this.writePending = false
      while (this.dirty) {
        this.dirty = false
        await atomicWriteFile(this.filePath, JSON.stringify(this.doc))
      }
    }
    this.tail = this.tail.then(run, run)
    return this.tail
  }
}
