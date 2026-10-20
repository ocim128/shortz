/**
 * `runDl` — normalize → pre-skip → resolve → select → plan → download → verify →
 * sidecar → state → events (download-engine.md §3).
 *
 * Contract guarantees this file exists to keep:
 *  - **one item verdict per input line, always** (D-A5): duplicates, junk and
 *    t.co links all get exactly one terminal event, so the renderer's row map
 *    cannot shift;
 *  - **exactly one `run-done`, on every path including cancel** (AUDIT A8);
 *  - **never throws for an item-level failure** — containment is per item, and
 *    only two pre-run caller bugs reject (no inputs; an unreadable data dir);
 *  - **codes, never sentences** — this module never composes user copy.
 */

import path from 'node:path'
import { logWarn } from '../log'
import { asDlError, DlError, isAbortError } from '../../shared/downloader/errors'
import { joinPlannedPath, renderPlannedPath } from '../../shared/downloader/naming'
import { extractStatusUrl, parseStatusUrl } from '../../shared/downloader/urls'
import { selectAllChosen } from '../../shared/downloader/select'
import type {
  Chosen,
  DlChosenInfo,
  DlEvent,
  DlItemEvent,
  DlItemStatus,
  DlQuality,
  DlRequest,
  DlRunSummary,
  DlSkipReason,
  ResolvedTweet,
  TweetRef
} from '../../shared/downloader/types'
import { createDlClient, type DlClient } from './net/client'
import { buildChain, type FailureProbe } from './resolve/chain'
import type { ResolveCtx } from './resolve/ctx'
import { fetchToFile, discardPartial, type DownloadOutcome, type FetchCtx } from './engine/fetch'
import { ThrottleState, sleep } from './engine/throttle'
import { StateStore } from './store/state'
import { buildSidecarPayload, readSidecar, writeSidecar } from './store/sidecar'
import { ensurePoster } from './store/posters'

// ---------------- frozen contract (section 3) ----------------
export interface DlRunOptions {
  outputDir: string
  layout: 'by-author' | 'by-date' | 'flat'
  filenameTemplate: string
  quality: DlQuality
  resolveConcurrency: number // 1..5, defaults 4
  downloadConcurrency: number // 1..3, defaults 3
  fallback: 'off' | 'fxtwitter' | 'auto'
  writeSidecars: boolean
  force: boolean
  dryRun: boolean
  retryFailed: boolean
}

export interface RunDeps {
  /** main passes ulid(); the CLI passes its own. Echoed on every event. */
  jobId: string
  /** <dataDir>/downloads/state.json and <dataDir>/downloads/cache/posters live here. */
  dataDir: string
  signal: AbortSignal
  onEvent: (e: DlEvent) => void
  options: DlRunOptions
  /** Hermetic-test seam. Defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Throttle clock. Defaults to () => performance.now(). */
  now?: () => number

  // ---- additive test seams (NOTES-A.md) ----
  client?: DlClient
  chain?: { resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet> }
  downloader?: (url: string, dest: string, ctx: FetchCtx) => Promise<DownloadOutcome>
  state?: StateStore
  probe?: FailureProbe | null
  /** Retry schedule override, e.g. `[0, 0, 0]` in tests. */
  backoffMs?: readonly number[]
  /** Pacing override; the default is a jittered 200–500 ms gap. */
  throttle?: ThrottleState
  logger?: (message: string) => void
}

const MAX_ATTEMPTS = 3
const BACKOFF_MS = [1000, 4000, 15000] as const
const FAILURE_STREAK_LIMIT = 8
const PROGRESS_INTERVAL_MS = 100

/** A counting semaphore — plain Promises, no worker pool. */
class Semaphore {
  private active = 0
  private readonly queue: (() => void)[] = []

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next !== undefined) next()
  }
}

/**
 * Bounded lookahead (AUDIT rev 2): an item may begin resolving only while fewer
 * than `downloadConcurrency × 2` items are in flight. Resolve is fast, a transfer
 * is slow — unbounded resolve would burn the rate limit and let the earliest
 * signed URLs expire before their slot arrives.
 */
class Lookahead {
  private inflight = 0
  private readonly waiters: (() => void)[] = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    while (this.inflight >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
    this.inflight += 1
  }

  release(): void {
    this.inflight = Math.max(0, this.inflight - 1)
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter()
  }
}

interface RunItem {
  key: string
  lineNumber: number
  index: number
  text: string
  tweetId: string | null
  ref: TweetRef | null
  /** The t.co link to expand, when the line needs one hop. */
  needsExpansion: string | null
  inputError: DlError | null
  duplicateOf: string | null
  settled: boolean
}

interface PlannedMedia {
  chosen: Chosen
  dest: string
  fileName: string
}

interface Prepared {
  resolved: ResolvedTweet
  plans: PlannedMedia[]
  plannedPaths: string[]
  chosenInfo: DlChosenInfo[]
  author: string
  caption: string
  localPosterPath?: string
}

interface ItemRuntime {
  item: RunItem
  media: NonNullable<DlItemEvent['item']['media']>
  plannedPaths: string[]
  /** Bytes already written to the media file currently in flight. */
  consumed: number
  lastProgressAt: number
  author?: string
  caption?: string
  chosen?: DlChosenInfo[]
  localPosterPath?: string
}

type Verdict = {
  status: 'ok' | 'partial' | 'failed' | 'skipped' | 'planned'
  files: string[]
  error?: DlError
  skipReason?: DlSkipReason
  plannedPaths?: string[]
  author?: string
  caption?: string
  chosen?: DlChosenInfo[]
  localPosterPath?: string
}

export async function runDl(req: DlRequest, deps: RunDeps): Promise<DlRunSummary> {
  const retryFailed = req.retryFailed === true || deps.options.retryFailed === true
  // ---- pre-run caller bugs: throw BEFORE the first event (D-A7) ----
  if (!retryFailed && req.inputs.length === 0) {
    throw new Error('The run has no input lines')
  }
  if (deps.options.outputDir.trim().length === 0) {
    throw new Error('The run has no output folder')
  }
  const state = deps.state ?? (await StateStore.open(deps.dataDir))
  const run = new DlRun(req, deps, state)
  return run.execute()
}

class DlRun {
  private readonly items: RunItem[]
  private readonly summary: DlRunSummary
  private readonly deps: RunDeps
  private readonly state: StateStore
  private readonly throttle: ThrottleState
  private readonly gated: DlClient
  private readonly resolveCtx: ResolveCtx
  private readonly chain: { resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet> }
  private readonly downloader: NonNullable<RunDeps['downloader']>
  private readonly log: (message: string) => void
  private readonly backoff: readonly number[]
  private readonly resolveSem: Semaphore
  private readonly downloadSem: Semaphore
  private readonly lookahead: Lookahead
  private readonly breaker = { streak: 0, open: false }
  private readonly claimed = new Map<string, string>()

  constructor(req: DlRequest, deps: RunDeps, state: StateStore) {
    this.deps = deps
    this.state = state
    this.log = deps.logger ?? logWarn
    this.backoff = deps.backoffMs ?? BACKOFF_MS
    const retryFailed = req.retryFailed === true || deps.options.retryFailed === true
    this.items = buildItems(req, state, retryFailed)
    // Duplicate bookkeeping is shared by parse-time ids and t.co expansions: a
    // line whose id is already known owns it before any expansion runs, so a
    // short link can never cause a second download of the same post.
    for (const item of this.items) {
      if (item.tweetId !== null && item.duplicateOf === null) {
        this.claimed.set(item.tweetId, item.key)
      }
    }
    this.summary = {
      jobId: deps.jobId,
      total: this.items.length,
      ok: 0,
      skipped: 0,
      partial: 0,
      failed: 0,
      cancelled: false
    }

    const client =
      deps.client ?? createDlClient({ fetchImpl: deps.fetchImpl, fallback: deps.options.fallback })
    this.throttle =
      deps.throttle ?? new ThrottleState(deps.now ?? (() => performance.now()), deps.signal)
    this.chain =
      deps.chain ?? buildChain({ fallback: deps.options.fallback, client, probe: deps.probe })
    this.downloader = deps.downloader ?? fetchToFile
    this.resolveSem = new Semaphore(clamp(deps.options.resolveConcurrency, 1, 5))
    this.downloadSem = new Semaphore(clamp(deps.options.downloadConcurrency, 1, 3))
    this.lookahead = new Lookahead(clamp(deps.options.downloadConcurrency, 1, 3) * 2)
    this.gated = this.gateClient(client)
    this.resolveCtx = { client: this.gated, signal: deps.signal }
  }

  // ---------------- run ----------------
  async execute(): Promise<DlRunSummary> {
    const startedAt = new Date().toISOString()
    let cancelledCount = 0
    try {
      await Promise.allSettled(this.items.map((item) => this.runOne(item)))
    } finally {
      const cancelled = this.deps.signal.aborted
      for (const item of this.items) {
        if (item.settled) continue
        item.settled = true
        this.emitItem(item, cancelled ? 'cancelled' : 'failed', {
          ...(cancelled
            ? { errorCode: 'CANCELLED' as const, errorDetail: 'run cancelled' }
            : { errorCode: 'UNEXPECTED' as const, errorDetail: 'item never settled' })
        })
        if (cancelled) cancelledCount += 1
        else this.summary.failed += 1
      }
      this.summary.cancelled = cancelled

      if (!this.deps.options.dryRun) {
        // Analyze writes NOTHING (D-A gate): no run row, no flush, no state file.
        try {
          this.state.recordRun(this.summary, startedAt, new Date().toISOString())
          await this.state.flush()
        } catch (error) {
          this.log(`[dl] could not record the run: ${asDlError(error).code}`)
        }
      }

      this.emit({
        jobId: this.deps.jobId,
        kind: 'run-done',
        total: this.summary.total,
        summary: {
          ok: this.summary.ok,
          skipped: this.summary.skipped,
          partial: this.summary.partial,
          failed: this.summary.failed,
          cancelled: cancelledCount
        },
        cancelled
      })
    }
    return this.summary
  }

  // ---------------- one item ----------------
  private async runOne(item: RunItem): Promise<void> {
    if (item.settled) return

    if (item.duplicateOf !== null) {
      this.finish(item, { status: 'skipped', files: [], skipReason: 'duplicate' })
      return
    }
    if (item.inputError !== null) {
      this.finish(item, { status: 'failed', files: [], error: item.inputError })
      return
    }
    if (this.breaker.open) {
      this.finish(item, { status: 'skipped', files: [], skipReason: 'circuit-open' })
      return
    }
    if (this.deps.signal.aborted) {
      this.finish(item, {
        status: 'failed',
        files: [],
        error: new DlError('CANCELLED', 'run cancelled')
      })
      return
    }

    try {
      // 1. A t.co line pays its single expansion hop before the id is known.
      if (item.needsExpansion !== null) {
        const expanded = await this.gated.expandTco(item.needsExpansion, {
          signal: this.deps.signal
        })
        const ref = parseStatusUrl(expanded)
        item.ref = ref
        item.tweetId = ref.tweetId
        if (this.claim(ref.tweetId) !== null) {
          this.finish(item, { status: 'skipped', files: [], skipReason: 'duplicate' })
          return
        }
      }
      const ref = item.ref
      const tweetId = item.tweetId
      if (ref === null || tweetId === null) {
        this.finish(item, {
          status: 'failed',
          files: [],
          error: new DlError('URL_UNRECOGNIZED', 'no status link on this line')
        })
        return
      }

      this.emitItem(item, 'resolving', { author: ref.screenName ?? undefined })

      // 2. Pre-skip BEFORE any resolve (AUDIT rev 2): zero network I/O, so an
      // offline re-run still skips cleanly (DU8/DA9).
      if (
        !this.deps.options.force &&
        !this.deps.options.dryRun &&
        (await this.state.isComplete(tweetId))
      ) {
        this.finish(item, { status: 'skipped', files: [], skipReason: 'already-downloaded' })
        return
      }

      // 3. Bounded lookahead, then prepare (resolve + select + plan + poster).
      await this.lookahead.acquire()
      try {
        // Re-check the breaker HERE: with N items every one of them passes the
        // check above before any of them finishes, so the early check is only a
        // fast path. This is the first moment an item actually enters the pipe.
        if (this.breaker.open) {
          this.finish(item, { status: 'skipped', files: [], skipReason: 'circuit-open' })
          return
        }
        const prepared = await this.prepare(ref)

        if (this.deps.options.dryRun) {
          this.finish(item, {
            status: 'planned',
            files: [],
            plannedPaths: prepared.plannedPaths,
            author: prepared.author,
            caption: prepared.caption,
            chosen: prepared.chosenInfo,
            ...(prepared.localPosterPath === undefined
              ? {}
              : { localPosterPath: prepared.localPosterPath })
          })
          return
        }

        const verdict = await this.transfer(item, prepared)
        this.finish(item, verdict)
      } finally {
        this.lookahead.release()
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.finish(item, {
          status: 'failed',
          files: [],
          error: new DlError('CANCELLED', 'cancelled mid-item')
        })
        throw error
      }
      this.finish(item, { status: 'failed', files: [], error: asDlError(error) })
    }
  }

  /** Resolve, select, plan — holds ONE resolve slot, never a download slot. */
  private async prepare(ref: TweetRef): Promise<Prepared> {
    const options = this.deps.options
    await this.resolveSem.acquire()
    try {
      const resolved = await this.chain.resolve(ref, this.resolveCtx)
      const chosen = selectAllChosen(resolved, options.quality)
      if (chosen.length === 0) {
        throw new DlError('NO_VIDEO', 'no downloadable video in this post')
      }

      const rootLength = options.outputDir.length + 1
      const plans: PlannedMedia[] = []
      const plannedPaths: string[] = []
      for (const one of chosen) {
        const planned = renderPlannedPath({
          tweet: {
            tweetId: resolved.ref.tweetId,
            author: resolved.author.screenName,
            createdAt: resolved.createdAt,
            text: resolved.text
          },
          mediaIndex: one.index,
          layout: options.layout,
          filenameTemplate: options.filenameTemplate,
          rootLength
        })
        const dest = joinPlannedPath(options.outputDir, planned, path.sep)
        plans.push({ chosen: one, dest, fileName: planned.fileName })
        plannedPaths.push(dest)
      }

      // The tweet row is written only now — after selection succeeded, with
      // mediaCount = downloadable assets (a photo-only post anchors nothing).
      if (!options.dryRun) {
        this.state.noteTweet({
          tweetId: resolved.ref.tweetId,
          author: resolved.author.screenName,
          caption: resolved.text,
          url: resolved.ref.canonicalUrl,
          mediaCount: chosen.length
        })
        await this.state.flush().catch(() => undefined)
      }

      // One poster per item: the frozen event carries a single localPosterPath
      // (NOTES-A D-A15). Best-effort, paced, and never allowed to fail the item.
      const posterAsset = chosen.find((one) => one.media.posterUrl !== null)
      let localPosterPath: string | undefined
      if (posterAsset !== undefined && posterAsset.media.posterUrl !== null) {
        await this.throttle.gate().catch(() => undefined)
        const poster = await ensurePoster({
          dataDir: this.deps.dataDir,
          tweetId: resolved.ref.tweetId,
          mediaIndex: posterAsset.index,
          posterUrl: posterAsset.media.posterUrl,
          client: this.gated,
          signal: this.deps.signal
        })
        if (poster !== null) localPosterPath = poster.path
      }

      const chosenInfo: DlChosenInfo[] = chosen.map((one) => ({
        index: one.index,
        width: one.variant.width ?? one.media.width,
        height: one.variant.height ?? one.media.height,
        bitrate: one.variant.bitrate,
        contentType: one.variant.contentType,
        url: one.variant.url
      }))

      const prepared: Prepared = {
        resolved,
        plans,
        plannedPaths,
        chosenInfo,
        author: resolved.author.screenName,
        caption: resolved.text,
        ...(localPosterPath === undefined ? {} : { localPosterPath })
      }
      // No 'planned' event here: the caller emits exactly ONE plan verdict
      // ('planned' in Analyze, 'downloading' otherwise), so a row never gets two
      // plan events with different statuses.
      return prepared
    } finally {
      this.resolveSem.release()
    }
  }

  /** Transfer every media file of one item. Never throws for media failures. */
  private async transfer(item: RunItem, prepared: Prepared): Promise<Verdict> {
    const { resolved, plans } = prepared
    const rt: ItemRuntime = {
      item,
      media: plans.map((plan) => ({
        index: plan.chosen.index,
        status: 'queued' as const,
        bytes: 0,
        total: null
      })),
      plannedPaths: prepared.plannedPaths,
      consumed: 0,
      lastProgressAt: 0,
      author: prepared.author,
      caption: prepared.caption,
      chosen: prepared.chosenInfo,
      ...(prepared.localPosterPath === undefined
        ? {}
        : { localPosterPath: prepared.localPosterPath })
    }

    this.emitItem(item, 'downloading', {
      author: prepared.author,
      caption: prepared.caption,
      plannedPaths: prepared.plannedPaths,
      chosen: prepared.chosenInfo,
      ...(rt.localPosterPath === undefined ? {} : { localPosterPath: rt.localPosterPath }),
      media: rt.media
    })

    const files: string[] = []
    let firstError: DlError | null = null

    for (let position = 0; position < plans.length; position += 1) {
      const plan = plans[position] as PlannedMedia
      if (this.deps.signal.aborted) {
        throw new DlError('CANCELLED', 'cancelled between media files')
      }
      rt.consumed = 0

      // Re-finalize: file + sidecar already on disk (crash window) — write the
      // state row and skip the transfer (storage-naming.md §4).
      if (!this.deps.options.force && (await this.tryRefinalize(plan, resolved))) {
        files.push(plan.dest)
        this.updateMedia(rt, position, 'ok', undefined, undefined)
        continue
      }

      await this.downloadSem.acquire()
      try {
        this.updateMedia(rt, position, 'downloading', undefined, undefined)
        const size = await this.downloadMedia(rt, position, plan, resolved)
        if (this.deps.options.writeSidecars) {
          await writeSidecar(
            plan.dest,
            buildSidecarPayload({
              resolved,
              asset: plan.chosen.media,
              variant: plan.chosen.variant,
              fileName: plan.fileName,
              sizeBytes: size
            })
          ).catch(() => undefined)
        }
        this.state.recordDownload({
          tweetId: resolved.ref.tweetId,
          mediaIndex: plan.chosen.index,
          filePath: plan.dest,
          sizeBytes: size,
          status: 'ok',
          source: resolved.source,
          runId: this.deps.jobId
        })
        files.push(plan.dest)
        this.updateMedia(rt, position, 'ok', size, size)
      } catch (error) {
        if (isAbortError(error)) throw error
        const dlError = asDlError(error)
        firstError = firstError ?? dlError
        this.state.recordDownload({
          tweetId: resolved.ref.tweetId,
          mediaIndex: plan.chosen.index,
          filePath: plan.dest,
          sizeBytes: 0,
          status: 'failed',
          error: describeForState(dlError),
          source: resolved.source,
          runId: this.deps.jobId
        })
        this.updateMedia(rt, position, 'failed', undefined, undefined)
      } finally {
        this.downloadSem.release()
        await this.state.flush().catch(() => undefined)
      }
    }

    await this.state.flush().catch(() => undefined)

    if (firstError !== null) {
      this.log(
        `[dl] ${sanitizeUrlForLog(resolved.ref.canonicalUrl)} -> ${firstError.code}${
          firstError.detail === undefined ? '' : `: ${firstError.detail}`
        }`
      )
      return {
        status: files.length > 0 ? 'partial' : 'failed',
        files,
        error: firstError,
        plannedPaths: prepared.plannedPaths,
        author: prepared.author,
        caption: prepared.caption,
        chosen: prepared.chosenInfo
      }
    }
    return {
      status: 'ok',
      files,
      plannedPaths: prepared.plannedPaths,
      author: prepared.author,
      caption: prepared.caption,
      chosen: prepared.chosenInfo,
      ...(prepared.localPosterPath === undefined
        ? {}
        : { localPosterPath: prepared.localPosterPath })
    }
  }

  /** One media file, with the retry schedule this layer owns (§4). */
  private async downloadMedia(
    rt: ItemRuntime,
    position: number,
    plan: PlannedMedia,
    resolved: ResolvedTweet
  ): Promise<number> {
    let attempt = 0
    let refreshed = false
    let restarted = false
    let url = plan.chosen.variant.url

    for (;;) {
      try {
        const outcome = await this.downloader(url, plan.dest, {
          client: this.gated,
          throttle: this.throttle,
          signal: this.deps.signal,
          onProgress: (delta, total) => {
            rt.consumed += delta
            this.maybeProgress(rt, position, total)
          }
        })
        return outcome.bytes
      } catch (error) {
        if (isAbortError(error)) throw error
        const dlError = asDlError(error)

        // A signed media URL outlives a normal download but not a long retry
        // chain: re-resolve ONCE, keep the bytes we already have.
        if (dlError.code === 'LINK_EXPIRED' && !refreshed) {
          refreshed = true
          const replacement = await this.refreshVariant(plan, resolved)
          if (replacement !== null) {
            url = replacement
            continue
          }
          throw dlError
        }

        // A broken transfer restarts clean ONCE, from a deleted .part.
        if (dlError.code === 'INTEGRITY_MISMATCH' && !restarted) {
          restarted = true
          await discardPartial(plan.dest)
          rt.consumed = 0
          continue
        }

        if (attempt < MAX_ATTEMPTS - 1 && shouldRetry(dlError)) {
          const delay = this.backoff[Math.min(attempt, this.backoff.length - 1)] ?? 0
          attempt += 1
          if (delay > 0) {
            await sleep(jittered(delay), this.deps.signal)
            rt.consumed = 0
          }
          continue
        }
        throw dlError
      }
    }
  }

  /** Re-resolve for a fresh signed URL (LINK_EXPIRED), under the resolve slot. */
  private async refreshVariant(
    plan: PlannedMedia,
    resolved: ResolvedTweet
  ): Promise<string | null> {
    await this.resolveSem.acquire()
    try {
      const fresh = await this.chain.resolve(resolved.ref, this.resolveCtx)
      const replacement = selectAllChosen(fresh, this.deps.options.quality).find(
        (one) => one.index === plan.chosen.index
      )
      if (replacement === undefined) return null
      plan.chosen = replacement
      return replacement.variant.url
    } catch {
      return null
    } finally {
      this.resolveSem.release()
    }
  }

  /** File + sidecar on disk but no state row (crash window): adopt, do not re-download. */
  private async tryRefinalize(plan: PlannedMedia, resolved: ResolvedTweet): Promise<boolean> {
    const stat = await statFile(plan.dest)
    if (stat === null) return false
    const sidecar = await readSidecar(plan.dest)
    if (sidecar === null) return false
    this.state.recordDownload({
      tweetId: resolved.ref.tweetId,
      mediaIndex: plan.chosen.index,
      filePath: plan.dest,
      sizeBytes: stat,
      status: 'ok',
      source: resolved.source,
      runId: this.deps.jobId
    })
    return true
  }

  // ---------------- events ----------------
  private emit(event: DlEvent): void {
    try {
      this.deps.onEvent(event)
    } catch (error) {
      this.log(
        `[dl] event handler threw: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  private emitItem(
    item: RunItem,
    status: DlItemStatus,
    extra: Partial<DlItemEvent['item']> = {}
  ): void {
    this.emit({
      jobId: this.deps.jobId,
      kind: 'item',
      key: item.key,
      lineNumber: item.lineNumber,
      index: item.index,
      total: this.summary.total,
      item: {
        tweetId: item.tweetId ?? '',
        status,
        ...extra
      }
    })
  }

  private updateMedia(
    rt: ItemRuntime,
    position: number,
    status: DlItemStatus,
    total: number | undefined,
    bytes: number | undefined
  ): void {
    const entry = rt.media[position]
    if (entry === undefined) return
    entry.status = status
    if (bytes !== undefined) entry.bytes = bytes
    if (total !== undefined) entry.total = total
    this.emitItem(rt.item, 'downloading', {
      author: rt.author,
      caption: rt.caption,
      plannedPaths: rt.plannedPaths,
      ...(rt.chosen === undefined ? {} : { chosen: rt.chosen }),
      ...(rt.localPosterPath === undefined ? {} : { localPosterPath: rt.localPosterPath }),
      media: rt.media.map((one) => ({ ...one }))
    })
  }

  private maybeProgress(rt: ItemRuntime, position: number, total: number | null): void {
    const now = this.deps.now?.() ?? Date.now()
    if (now - rt.lastProgressAt < PROGRESS_INTERVAL_MS) return
    rt.lastProgressAt = now
    const entry = rt.media[position]
    if (entry !== undefined) entry.bytes = rt.consumed
    this.emit({
      jobId: this.deps.jobId,
      kind: 'media-progress',
      key: rt.item.key,
      lineNumber: rt.item.lineNumber,
      index: rt.item.index,
      itemTotal: this.summary.total,
      mediaIndex: rt.media[position]?.index ?? position + 1,
      bytes: rt.consumed,
      total
    })
  }

  private finish(item: RunItem, verdict: Verdict): void {
    if (item.settled) return
    item.settled = true
    const extra = verdict

    if (verdict.status === 'skipped') {
      this.emitItem(item, 'skipped', {
        skipReason: verdict.skipReason,
        ...(extra.author === undefined ? {} : { author: extra.author })
      })
      this.summary.skipped += 1
      return
    }
    if (verdict.status === 'failed') {
      const error = verdict.error ?? new DlError('UNEXPECTED', 'no error recorded')
      this.emitItem(item, 'failed', {
        errorCode: error.code,
        errorDetail: error.detail ?? error.code,
        files: verdict.files,
        ...(extra.plannedPaths === undefined ? {} : { plannedPaths: extra.plannedPaths }),
        ...(extra.chosen === undefined ? {} : { chosen: extra.chosen }),
        ...(extra.author === undefined ? {} : { author: extra.author }),
        ...(extra.caption === undefined ? {} : { caption: extra.caption })
      })
      this.summary.failed += 1
      this.bumpBreaker()
      return
    }
    this.emitItem(item, verdict.status, {
      files: verdict.files,
      ...(extra.plannedPaths === undefined ? {} : { plannedPaths: extra.plannedPaths }),
      ...(extra.author === undefined ? {} : { author: extra.author }),
      ...(extra.caption === undefined ? {} : { caption: extra.caption }),
      ...(extra.chosen === undefined ? {} : { chosen: extra.chosen }),
      ...(extra.localPosterPath === undefined ? {} : { localPosterPath: extra.localPosterPath }),
      ...(verdict.error === undefined ? {} : { errorCode: verdict.error.code })
    })

    if (verdict.status === 'ok') {
      this.summary.ok += 1
      this.breaker.streak = 0
    } else if (verdict.status === 'partial') {
      this.summary.partial += 1
      this.bumpBreaker()
    } else {
      // Analyze: nothing failed and nothing was written. Counted as ok so the
      // summary never implies failures that do not exist (NOTES-A).
      this.summary.ok += 1
    }
  }

  private bumpBreaker(): void {
    this.breaker.streak += 1
    if (!this.breaker.open && this.breaker.streak >= FAILURE_STREAK_LIMIT) {
      this.breaker.open = true
      this.log(
        `[dl] circuit open after ${FAILURE_STREAK_LIMIT} consecutive failures — remaining lines skipped (Retry failed continues)`
      )
    }
  }

  private claim(tweetId: string): string | null {
    const existing = this.claimed.get(tweetId)
    if (existing !== undefined) return existing
    this.claimed.set(tweetId, tweetId)
    return null
  }

  /** Gate resolve traffic through the shared throttle and feed its 429s back. */
  private gateClient(client: DlClient): DlClient {
    const report = (error: unknown): void => {
      if (error instanceof DlError && error.code === 'RATE_LIMITED') {
        this.throttle.report429Ms(error.retryAfterMs)
      }
    }
    return {
      getJson: async (url, opts) => {
        await this.throttle.gate()
        try {
          return await client.getJson(url, opts)
        } catch (error) {
          report(error)
          throw error
        }
      },
      expandTco: async (url, opts) => {
        await this.throttle.gate()
        try {
          return await client.expandTco(url, opts)
        } catch (error) {
          report(error)
          throw error
        }
      },
      streamTo: client.streamTo.bind(client),
      probeStatus: async (url, opts) => {
        await this.throttle.gate()
        try {
          return await client.probeStatus(url, opts)
        } catch (error) {
          report(error)
          throw error
        }
      }
    }
  }
}

// ---------------- module helpers ----------------

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return high
  return Math.min(high, Math.max(low, Math.round(value)))
}

function jittered(base: number): number {
  return Math.round(base * (0.8 + Math.random() * 0.4))
}

function shouldRetry(error: DlError): boolean {
  return (
    error.code === 'NETWORK' || error.code === 'UPSTREAM_ERROR' || error.code === 'RATE_LIMITED'
  )
}

function describeForState(error: DlError): string {
  return error.detail === undefined ? error.code : `${error.code}: ${error.detail}`
}

async function statFile(filePath: string): Promise<number | null> {
  const { promises: fs } = await import('node:fs')
  const stat = await fs.stat(filePath).catch(() => null)
  if (stat === null || !stat.isFile() || stat.size === 0) return null
  return stat.size
}

/** Strip the query string (signed params) before a URL reaches a log line. */
export function sanitizeUrlForLog(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return url.slice(0, 200)
  }
}

/** Items from the request (normal mode) or from the state index (retry-failed). */
function buildItems(req: DlRequest, state: StateStore, retryFailed: boolean): RunItem[] {
  const items: RunItem[] = []
  const seen = new Map<string, string>()

  if (retryFailed) {
    state.retryTargets().forEach((tweetId, position) => {
      const tweet = state.tweet(tweetId)
      const ref: TweetRef = {
        tweetId,
        screenName: tweet?.author ?? null,
        canonicalUrl: tweet?.url ?? `https://x.com/i/status/${tweetId}`
      }
      items.push({
        key: `retry-${tweetId}`,
        lineNumber: position + 1,
        index: position,
        text: ref.canonicalUrl,
        tweetId,
        ref,
        needsExpansion: null,
        inputError: null,
        duplicateOf: null,
        settled: false
      })
    })
    return items
  }

  req.inputs.forEach((input, position) => {
    const line: RunItem = {
      key: input.key,
      lineNumber: input.lineNumber,
      index: position,
      text: input.text,
      tweetId: null,
      ref: null,
      needsExpansion: null,
      inputError: null,
      duplicateOf: null,
      settled: false
    }
    try {
      const ref = parseStatusUrl(input.text)
      line.ref = ref
      line.tweetId = ref.tweetId
      const earlier = seen.get(ref.tweetId)
      if (earlier !== undefined) line.duplicateOf = earlier
      else seen.set(ref.tweetId, input.key)
    } catch (error) {
      const dlError = error instanceof DlError ? error : asDlError(error)
      const candidate = extractStatusUrl(input.text)
      if (dlError.code === 'URL_UNRECOGNIZED' && candidate !== null && /t\.co\//i.test(candidate)) {
        line.needsExpansion = candidate
      } else {
        line.inputError = dlError
      }
    }
    items.push(line)
  })
  return items
}
