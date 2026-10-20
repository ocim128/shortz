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

  private constructor(
    private readonly filePath: string,
    doc: StateDoc
  ) {
    this.doc = doc
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
    const out: StateDownloadRow[] = []
    for (const [key, row] of Object.entries(this.doc.downloads)) {
      if (key.startsWith(`${tweetId}:`)) out.push(row)
    }
    return out
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
      const rows: { mediaIndex: number; row: StateDownloadRow }[] = []
      for (const [key, row] of Object.entries(this.doc.downloads)) {
        if (!key.startsWith(`${tweetId}:`)) continue
        rows.push({ mediaIndex: Number.parseInt(key.slice(tweetId.length + 1), 10), row })
      }
      if (rows.length === 0) continue

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
      const rows = this.downloadsOf(tweetId)
      const okRows = rows.filter((row) => row.status === 'ok').length
      const failed = rows.some((row) => row.status === 'failed')
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
    this.doc.downloads[key] = {
      filePath: row.filePath,
      sizeBytes: row.sizeBytes,
      status: row.status,
      error: row.error ?? null,
      source: row.source,
      runId: row.runId,
      downloadedAt: row.status === 'ok' ? at : (existing?.downloadedAt ?? at),
      updatedAt: at
    }
  }

  /** Forget a media row (a file that vanished, or a clean restart over it). */
  forgetDownload(tweetId: string, mediaIndex: number): void {
    delete this.doc.downloads[downloadKey(tweetId, mediaIndex)]
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
   * Flush the whole document atomically. Calls are serialized so two item
   * boundaries can never interleave their temp files.
   */
  flush(): Promise<void> {
    const run = async (): Promise<void> => {
      await atomicWriteFile(this.filePath, JSON.stringify(this.doc, null, 2))
    }
    this.tail = this.tail.then(run, run)
    return this.tail
  }
}
