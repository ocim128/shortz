import fsp from 'node:fs/promises'
import path from 'node:path'
import { session, shell } from 'electron'
import { ulid } from 'ulid'
import type { Settings } from '../shared/domain'
import { dlErrorMessage } from '../shared/downloader/copy'
import type {
  DlEvent,
  DlItemEvent,
  DlListEntry,
  DlMediaProgressEvent,
  DlRequest,
  DlRunDoneEvent
} from '../shared/downloader/types'
import type { DlProgressEvent } from '../preload/api'
import { runDl, type DlRunOptions } from '../core/downloader/orchestrator'
import { StateStore } from '../core/downloader/store/state'
import { logInfo, logWarn } from '../core/log'
import { currentSettings, dlPostersDir } from './data'
import { createDlEventCoalescer } from './dl-coalesce'
import { mintMediaUrl } from './protocol/media'

/**
 * Downloader main-process glue: IPC lifecycle, the single-flight slot, the
 * settings→options mapping, coalescing, and the two renderer-only enrichments
 * (poster URLs and error sentences).
 *
 * Everything Electron-shaped stays here so `src/core/downloader/**` remains
 * testable without a window. `handle` and the job slots arrive as deps because
 * they are private to ipc.ts (AUDIT A17).
 *
 * Contract notes:
 * - The slot clears in exactly one place: the forwarded `run-done`. The catch
 *   below emits a synthetic terminal event only when the core died without one,
 *   so `dlInFlight` cannot leak (AUDIT A8).
 * - Main phrases errors (`copy.ts`); the renderer never composes a sentence
 *   (AUDIT A7).
 * - Posters are minted here — `getMediaUrl` validates video extensions only and
 *   would reject a `.jpg` (AUDIT A6).
 */

const PROGRESS_CHANNEL = 'shortz:dl:progress'

export interface DownloaderIpcDeps {
  handle: <A extends unknown[]>(channel: string, fn: (...args: A) => Promise<unknown>) => void
  jobSlots: { exportInFlight: boolean; dlInFlight: boolean }
  sendToRenderer: (channel: string, payload: unknown) => void
  dataDir: () => string
}

/** The one in-flight run's abort handle (single-flight makes one enough). */
let activeAbort: AbortController | null = null
let activeJobId: string | null = null

/** Request wins over settings — the one place both halves of the feature meet. */
export function buildRunOptions(req: DlRequest, settings: Settings): DlRunOptions {
  const downloads = settings.downloads
  return {
    outputDir: req.outputDir ?? downloads.dir,
    layout: downloads.layout,
    filenameTemplate: downloads.filenameTemplate,
    quality: req.quality ?? downloads.quality,
    resolveConcurrency: downloads.resolveConcurrency,
    downloadConcurrency: downloads.downloadConcurrency,
    fallback: downloads.fallback,
    writeSidecars: downloads.writeSidecars,
    force: req.force ?? false,
    dryRun: req.dryRun ?? false,
    retryFailed: req.retryFailed === true
  }
}

function isDirectProxyRule(rule: string): boolean {
  const normalized = rule.trim().toLowerCase()
  return normalized.length === 0 || normalized === 'direct://' || normalized === 'direct'
}

/** Poster cache entries are `<tweetId>_<mediaIndex>.jpg` (storage-naming §5). */
async function posterUrlFor(tweetId: string, mediaIndexes: number[]): Promise<string | undefined> {
  const dir = dlPostersDir()
  const candidates = (mediaIndexes.length > 0 ? mediaIndexes : [1]).map((index) =>
    path.join(dir, `${tweetId}_${index}.jpg`)
  )
  for (const candidate of candidates) {
    const stat = await fsp.stat(candidate).catch(() => null)
    if (stat?.isFile()) return mintMediaUrl(candidate)
  }
  return undefined
}

export function registerDownloaderIpc(deps: DownloaderIpcDeps): void {
  deps.handle('shortz:dl:start', async (req: DlRequest): Promise<{ jobId: string }> => {
    if (deps.jobSlots.dlInFlight) {
      throw new Error('A download run is already active — cancel it first')
    }
    if (!req || !Array.isArray(req.inputs)) {
      throw new Error('Malformed download request')
    }
    if (req.inputs.length === 0 && req.retryFailed !== true) {
      throw new Error('Paste at least one link first')
    }

    const settings = await currentSettings()
    const options = buildRunOptions(req, settings)
    const jobId = ulid()
    const controller = new AbortController()

    // Per-run state — nothing leaks between runs.
    let terminalSent = false
    let proxyHinted = false
    let proxyProbe: Promise<boolean> | null = null

    const finish = (): void => {
      if (terminalSent) return
      terminalSent = true
      deps.jobSlots.dlInFlight = false
      activeAbort = null
      activeJobId = null
    }

    const send = (payload: DlProgressEvent): void => deps.sendToRenderer(PROGRESS_CHANNEL, payload)

    const hintSystemProxy = (tweetId: string, resend: () => void): void => {
      if (proxyHinted) return
      proxyHinted = true
      if (!proxyProbe) {
        const url = `https://x.com/i/status/${tweetId}`
        proxyProbe = session.defaultSession
          .resolveProxy(url)
          .then((rule) => !isDirectProxyRule(rule))
          .catch(() => false)
      }
      void proxyProbe.then((proxied) => {
        if (!proxied) return
        logWarn('[dl] NETWORK failure with a system proxy configured — hint sent to the row')
        resend()
      })
    }

    const wireItem = (e: DlItemEvent, extraError?: string): DlProgressEvent => {
      const { localPosterPath, ...rest } = e.item
      const item: NonNullable<DlProgressEvent['item']> = { ...rest }
      if (localPosterPath !== undefined) item.posterMediaUrl = mintMediaUrl(localPosterPath)
      if (rest.errorCode !== undefined) {
        const sentence = dlErrorMessage(rest.errorCode)
        item.error = extraError !== undefined ? `${sentence} ${extraError}` : sentence
      }
      return {
        jobId,
        key: e.key,
        lineNumber: e.lineNumber,
        index: e.index,
        total: e.total,
        kind: 'item',
        item
      }
    }

    const wireMediaProgress = (e: DlMediaProgressEvent): DlProgressEvent => ({
      jobId,
      key: e.key,
      lineNumber: e.lineNumber,
      index: e.index,
      // The wire's top-level `total` is the run's item count (v1 erratum:
      // the core calls the byte total `total` and the item count `itemTotal`).
      total: e.itemTotal,
      kind: 'media-progress',
      mediaIndex: e.mediaIndex,
      bytes: e.bytes,
      mediaTotal: e.total
    })

    const wireRunDone = (e: DlRunDoneEvent): DlProgressEvent => ({
      jobId,
      key: '',
      lineNumber: 0,
      index: e.total,
      total: e.total,
      kind: 'run-done',
      summary: e.summary
    })

    const coalescer = createDlEventCoalescer({
      emit: (event: DlEvent) => {
        if (event.kind === 'media-progress') {
          send(wireMediaProgress(event))
          return
        }
        if (event.kind === 'run-done') {
          send(wireRunDone(event))
          finish()
          logInfo(
            `[dl] ${jobId} done — ok=${event.summary.ok} skipped=${event.summary.skipped} ` +
              `partial=${event.summary.partial} failed=${event.summary.failed} ` +
              `cancelled=${event.summary.cancelled}`
          )
          return
        }
        const payload = wireItem(event)
        send(payload)
        // A proxy is the most likely NETWORK cause on Windows (AUDIT A24):
        // probe once per run and re-send this row with the hint. The row is
        // sent first so the failure is never delayed by the probe.
        if (event.item.errorCode === 'NETWORK' && !proxyHinted) {
          hintSystemProxy(event.item.tweetId, () => {
            const hint = `A system proxy is configured — ShortZ doesn't use it yet.`
            send(wireItem(event, hint))
          })
        }
      }
    })

    deps.jobSlots.dlInFlight = true
    activeAbort = controller
    activeJobId = jobId
    logInfo(
      `[dl] ${jobId} start — ${req.inputs.length} line(s), ` +
        `${options.dryRun ? 'dry-run' : 'download'}, ${options.layout}, q=${JSON.stringify(options.quality)}`
    )

    // Fire and forget: the renderer gets the jobId now and events as they come.
    void runDl(req, {
      jobId,
      dataDir: deps.dataDir(),
      signal: controller.signal,
      onEvent: (event) => coalescer.push(event),
      options
    })
      .then((summary) => {
        // The orchestrator's contract is exactly one run-done; this is the
        // belt-and-braces terminal event for a core that returned without one.
        if (!terminalSent) {
          logWarn(`[dl] ${jobId} returned without a run-done — synthesizing one`)
          coalescer.push({
            jobId,
            kind: 'run-done',
            total: summary.total,
            summary: {
              ok: summary.ok,
              skipped: summary.skipped,
              partial: summary.partial,
              failed: summary.failed,
              // DlRunSummary.cancelled is a boolean; the event's summary wants a
              // count. This fallback path has no per-item detail to count.
              cancelled: summary.cancelled ? 1 : 0
            },
            cancelled: summary.cancelled
          })
        }
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        logWarn(`[dl] ${jobId} died without a terminal event: ${detail}`)
        if (terminalSent) return
        const cancelled = controller.signal.aborted
        coalescer.push({
          jobId,
          kind: 'run-done',
          total: 1,
          summary: {
            ok: 0,
            skipped: 0,
            partial: 0,
            failed: cancelled ? 0 : 1,
            cancelled: cancelled ? 1 : 0
          },
          cancelled
        })
      })

    return { jobId }
  })

  deps.handle('shortz:dl:cancel', async (): Promise<void> => {
    if (!activeAbort || !deps.jobSlots.dlInFlight) return
    logInfo(`[dl] ${activeJobId ?? '?'} cancel requested`)
    activeAbort.abort()
  })

  deps.handle('shortz:dl:list', async (): Promise<DlListEntry[]> => {
    const store = await StateStore.open(deps.dataDir())
    const entries = store.listEntries(100)
    return Promise.all(
      entries.map(async (entry) => {
        const poster = await posterUrlFor(
          entry.tweetId,
          entry.files.map((file) => file.mediaIndex)
        )
        return poster !== undefined ? { ...entry, posterMediaUrl: poster } : entry
      })
    )
  })

  deps.handle('shortz:dl:openFolder', async (): Promise<void> => {
    const settings = await currentSettings()
    const dir = settings.downloads.dir
    const stat = await fsp.stat(dir).catch(() => null)
    if (!stat || !stat.isDirectory()) {
      throw new Error(`Cannot open "${dir}": the folder no longer exists`)
    }
    // shell.openPath resolves to an error string ('' on success).
    const error = await shell.openPath(dir)
    if (error) throw new Error(`Cannot open "${dir}": ${error}`)
  })
}
