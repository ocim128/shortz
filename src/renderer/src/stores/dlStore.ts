import { create } from 'zustand'
import type {
  DlErrorCode,
  DlItemStatus,
  DlListEntry,
  DlMediaState,
  DlProgressEvent,
  DlRequest,
  DlSkipReason,
  Unsubscribe
} from '../../../preload/api'
import type { DlLineProblemCode, ParsedLine } from '../../../shared/downloader/parse-run-input'
import { parseRunInput } from '../../../shared/downloader/parse-run-input'
import { toast } from './toastStore'
import { S } from '../strings'

/**
 * dlStore — the Downloader screen's state (docs/twitter-downloader/technical/
 * ui-and-ipc.md §5), modelled on batchStore: zustand, an `applyEvent` reducer
 * driven by the one App-level subscription, and a draft that survives navigating
 * away and back.
 *
 * Two invariants make the row map safe:
 * - rows are keyed by the event's `key` ('line-<n>', or A's synthesized
 *   `retry-<tweetId>` keys), never by position; an unseen key is appended.
 * - the parsed lines are snapshotted at start, so editing the textarea mid-run
 *   cannot move a row (the textarea is read-only while running anyway).
 */

export type DlPhase = 'idle' | 'running' | 'finished'
export type DlRunMode = 'analyze' | 'download' | 'retry'

export interface DlRowProgress {
  mediaIndex: number
  bytes: number
  total: number | null
}

export interface DlRow {
  key: string
  lineNumber: number
  text: string
  /** Renderer preview verdicts; main's item events are authoritative. */
  preview: DlLineProblemCode[]
  tweetId: string
  status: DlItemStatus
  /** 0-based position among the run's items, once main has said anything. */
  index: number | null
  author?: string
  caption?: string
  posterMediaUrl?: string
  plannedPaths?: string[]
  files?: string[]
  /** Sentence phrased by main (copy.ts) — never composed here. */
  error?: string
  errorCode?: DlErrorCode
  errorDetail?: string
  skipReason?: DlSkipReason
  media?: DlMediaState[]
  progress?: DlRowProgress
}

export interface DlRun {
  jobId: string
  mode: DlRunMode
  rows: Map<string, DlRow>
  /** Render order — seeded from the parse snapshot, appended per unseen key. */
  order: string[]
  itemTotal: number
  activeIndex: number
  summary: DlRunSummaryCounts | null
  cancelled: boolean
}

export interface DlRunSummaryCounts {
  ok: number
  skipped: number
  partial: number
  failed: number
  cancelled: number
}

const IN_FLIGHT: ReadonlySet<DlItemStatus> = new Set([
  'queued',
  'resolving',
  'planned',
  'downloading'
])

const TERMINAL: ReadonlySet<DlItemStatus> = new Set([
  'skipped',
  'ok',
  'partial',
  'failed',
  'cancelled'
])

interface DlStoreState {
  text: string
  phase: DlPhase
  run: DlRun | null
  history: DlListEntry[]
  error: string | null
  setText: (text: string) => void
  loadHistory: () => Promise<void>
  /** Download the pasted lines. */
  start: () => Promise<void>
  /** Analyze = the same run with dryRun: true. */
  analyze: () => Promise<void>
  /** Re-enqueue the state index's failed/incomplete posts (textarea may be empty). */
  retryFailed: () => Promise<void>
  cancel: () => Promise<void>
  openFolder: () => Promise<void>
  applyEvent: (e: DlProgressEvent) => void
}

function seedRow(line: ParsedLine): DlRow {
  return {
    key: line.key,
    lineNumber: line.lineNumber,
    text: line.text,
    preview: line.problems,
    tweetId: line.tweetId ?? '',
    status: 'queued',
    index: null
  }
}

const initial = {
  text: '',
  phase: 'idle' as DlPhase,
  run: null as DlRun | null,
  history: [] as DlListEntry[],
  error: null as string | null
}

export const useDlStore = create<DlStoreState>((set, get) => {
  /** Shared start path: Analyze differs only by dryRun (D-B10). */
  const begin = async (mode: DlRunMode): Promise<void> => {
    if (get().phase === 'running') return

    const parsed = mode === 'retry' ? [] : parseRunInput(get().text)
    // Junk and duplicates are sent too — main owns every verdict (AUDIT A22).
    if (mode !== 'retry' && parsed.length === 0) {
      toast.err(S.dlDownloadDisabled)
      return
    }

    const rows = new Map<string, DlRow>()
    const order: string[] = []
    for (const line of parsed) {
      rows.set(line.key, seedRow(line))
      order.push(line.key)
    }

    const req: DlRequest =
      mode === 'retry'
        ? { inputs: [], retryFailed: true }
        : {
            inputs: parsed.map((line) => ({
              key: line.key,
              lineNumber: line.lineNumber,
              text: line.text
            })),
            ...(mode === 'analyze' ? { dryRun: true } : {})
          }

    set({
      phase: 'running',
      error: null,
      run: {
        jobId: '',
        mode,
        rows,
        order,
        itemTotal: parsed.length,
        activeIndex: -1,
        summary: null,
        cancelled: false
      }
    })

    try {
      const { jobId } = await window.shortz.dlStart(req)
      set((prev) => (prev.run ? { run: { ...prev.run, jobId } } : {}))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ phase: 'idle', run: null, error: message })
      toast.err(`${S.dlStartError}: ${message}`)
    }
  }

  return {
    ...initial,

    setText: (text) => set({ text }),

    loadHistory: async () => {
      try {
        const history = await window.shortz.dlList()
        set({ history })
      } catch {
        /* history is a nicety — never block the screen on it */
      }
    },

    start: () => begin('download'),
    analyze: () => begin('analyze'),
    retryFailed: () => begin('retry'),

    cancel: async () => {
      if (get().phase !== 'running') return
      await window.shortz.dlCancel().catch(() => undefined)
    },

    openFolder: async () => {
      try {
        await window.shortz.dlOpenFolder()
      } catch (err) {
        toast.err(err instanceof Error ? err.message : String(err))
      }
    },

    applyEvent: (e) => {
      if (e.kind === 'run-done') {
        set((prev) => {
          const current = prev.run
          if (!current) return {}
          const rows = new Map(current.rows)
          const summary = e.summary ?? null
          // Belt and braces: main also emits an item event per affected key.
          // On a cancel, anything still in flight settles as cancelled so no
          // row can spin forever after the terminal event.
          if (summary && summary.cancelled > 0) {
            for (const [key, row] of rows) {
              if (IN_FLIGHT.has(row.status)) rows.set(key, { ...row, status: 'cancelled' })
            }
          }
          return {
            phase: 'finished' as DlPhase,
            run: {
              ...current,
              jobId: e.jobId || current.jobId,
              rows,
              itemTotal: e.total > 0 ? e.total : current.itemTotal,
              activeIndex: -1,
              summary,
              cancelled: (summary?.cancelled ?? 0) > 0
            }
          }
        })
        return
      }

      if (e.kind === 'media-progress') {
        set((prev) => {
          const current = prev.run
          if (!current) return {}
          const existing = current.rows.get(e.key)
          // A tick without a row means the item event has not arrived yet;
          // dropping it loses nothing (the next tick or the item event wins).
          if (!existing || TERMINAL.has(existing.status)) return {}
          const rows = new Map(current.rows)
          rows.set(e.key, {
            ...existing,
            status: 'downloading',
            progress: {
              mediaIndex: e.mediaIndex ?? 1,
              bytes: e.bytes ?? 0,
              total: e.mediaTotal ?? null
            }
          })
          return {
            run: {
              ...current,
              jobId: e.jobId || current.jobId,
              rows,
              itemTotal: e.total > 0 ? e.total : current.itemTotal,
              activeIndex: e.index
            }
          }
        })
        return
      }

      set((prev) => {
        const current = prev.run
        if (!current) return {}
        const existing = current.rows.get(e.key)
        const item = e.item
        const rows = new Map(current.rows)
        const next: DlRow = {
          ...(existing ?? {
            key: e.key,
            lineNumber: e.lineNumber,
            text: '',
            preview: [] as DlLineProblemCode[],
            tweetId: item?.tweetId ?? '',
            status: 'queued' as DlItemStatus,
            index: null
          }),
          lineNumber: e.lineNumber || existing?.lineNumber || 0,
          index: e.index,
          ...(item
            ? {
                tweetId: item.tweetId,
                status: item.status,
                ...(item.author !== undefined ? { author: item.author } : {}),
                ...(item.caption !== undefined ? { caption: item.caption } : {}),
                ...(item.posterMediaUrl !== undefined
                  ? { posterMediaUrl: item.posterMediaUrl }
                  : {}),
                ...(item.plannedPaths !== undefined ? { plannedPaths: item.plannedPaths } : {}),
                ...(item.files !== undefined ? { files: item.files } : {}),
                ...(item.error !== undefined ? { error: item.error } : {}),
                ...(item.errorCode !== undefined ? { errorCode: item.errorCode } : {}),
                ...(item.errorDetail !== undefined ? { errorDetail: item.errorDetail } : {}),
                ...(item.skipReason !== undefined ? { skipReason: item.skipReason } : {}),
                ...(item.media !== undefined ? { media: item.media } : {})
              }
            : {})
        }
        // Terminal rows drop their byte progress so the bar cannot linger.
        if (item && TERMINAL.has(item.status)) delete next.progress
        rows.set(e.key, next)
        const order = existing ? current.order : [...current.order, e.key]
        return {
          run: {
            ...current,
            jobId: e.jobId || current.jobId,
            rows,
            order,
            itemTotal: e.total > 0 ? e.total : current.itemTotal,
            activeIndex: item && TERMINAL.has(item.status) ? current.activeIndex : e.index
          }
        }
      })
    }
  }
})

/** Subscribe once at App mount; returns the unsubscribe (mirrors batchStore). */
export function subscribeDlProgress(): Unsubscribe {
  return window.shortz.onDlProgress((e) => useDlStore.getState().applyEvent(e))
}
