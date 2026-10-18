import { create } from 'zustand'
import type {
  BatchRenderEvent,
  BatchRunRequest,
  BatchRunSummary,
  Unsubscribe
} from '../../../preload/api'
import { toast } from './toastStore'
import { S } from '../strings'

/**
 * batchStore — the batch queue screen's state: every parsed line's per-item
 * status as progress events stream in, the run lifecycle, and the DRAFT (what
 * the user typed, which config is selected). The draft lives here — not in
 * component state — so navigating Home and back does not wipe a half-entered
 * batch; it is never reset by a run, only by editing.
 */

export interface BatchDraft {
  /** The textarea's raw contents (`path•hook` per line). */
  text: string
  /** Selected saved editor config; '' when none exists yet. */
  configId: string
  /** Apply the config's trim range to every item. */
  applyTrim: boolean
}

export type BatchItemState = 'pending' | 'probing' | 'rendering' | 'done' | 'error' | 'skipped'

export interface BatchItemProgress {
  status: BatchItemState
  percent: number
  stage?: string
  outputPath?: string
  error?: string
}

export type BatchPhase = 'idle' | 'running' | 'finished'

interface BatchStoreState {
  phase: BatchPhase
  jobId: string | null
  /** Index of the item currently being rendered, or -1. */
  activeIndex: number
  total: number
  completed: number
  failed: number
  cancelled: boolean
  items: Record<number, BatchItemProgress>
  /** Terminal summary for the footer, cleared on the next run. */
  summary: BatchRunSummary | null
  error: string | null
  draft: BatchDraft
  setDraft: (patch: Partial<BatchDraft>) => void
  run: (req: BatchRunRequest) => Promise<BatchRunSummary | null>
  cancel: () => Promise<void>
  reset: () => void
  applyEvent: (e: BatchRenderEvent) => void
}

const initial = {
  phase: 'idle' as BatchPhase,
  jobId: null as string | null,
  activeIndex: -1,
  total: 0,
  completed: 0,
  failed: 0,
  cancelled: false,
  items: {} as Record<number, BatchItemProgress>,
  summary: null as BatchRunSummary | null,
  error: null as string | null
}

export const useBatchStore = create<BatchStoreState>((set, get) => ({
  ...initial,
  // applyTrim defaults OFF: a saved config's range is tied to the clip it was
  // tuned on and would silently cut other (longer) videos short.
  draft: { text: '', configId: '', applyTrim: false },

  setDraft: (patch) => set((prev) => ({ draft: { ...prev.draft, ...patch } })),

  run: async (req) => {
    if (get().phase === 'running') return null
    if (req.items.length === 0) {
      toast.err(S.batchEmptyError)
      return null
    }
    set({ ...initial, phase: 'running' })
    // Seed every line as pending so the list renders the full queue at once.
    const seeded: Record<number, BatchItemProgress> = {}
    req.items.forEach((_item, i) => {
      seeded[i] = { status: 'pending', percent: 0 }
    })
    set({ items: seeded, total: req.items.length })

    try {
      const summary = await window.shortz.batchRender(req)
      set({ phase: 'finished', summary, cancelled: summary.cancelled })
      if (summary.cancelled) toast.info(S.batchCancelledToast)
      else if (summary.failed > 0) toast.err(S.batchFinishedWithErrors(summary.completed, summary.failed))
      else toast.ok(S.batchFinishedToast(summary.completed))
      return summary
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      set({ phase: 'finished', error: message })
      toast.err(`${S.errBatchRender}: ${message}`)
      return null
    }
  },

  cancel: async () => {
    const { phase, jobId } = get()
    if (phase !== 'running') return
    await window.shortz.cancelBatch(jobId ?? undefined).catch(() => undefined)
  },

  reset: () => set({ ...initial }),

  applyEvent: (e) => {
    // Terminal event: record the summary counts, keep per-item verdicts.
    if (e.status === 'finished' || e.status === 'cancelled') {
      set({
        phase: 'finished',
        activeIndex: -1,
        jobId: e.jobId,
        completed: e.completed ?? get().completed,
        failed: e.failed ?? get().failed,
        cancelled: e.status === 'cancelled'
      })
      return
    }
    if (e.status === 'starting') {
      set({ jobId: e.jobId, total: e.total, activeIndex: 0 })
      return
    }
    if (e.status === 'done') {
      set((prev) => ({
        jobId: e.jobId,
        completed: prev.completed + 1,
        items: {
          ...prev.items,
          [e.index]: {
            status: 'done',
            percent: 100,
            ...(e.outputPath ? { outputPath: e.outputPath } : {})
          }
        }
      }))
      return
    }
    if (e.status === 'error') {
      set((prev) => ({
        jobId: e.jobId,
        failed: prev.failed + 1,
        items: {
          ...prev.items,
          [e.index]: {
            status: 'error',
            percent: 0,
            ...(e.error ? { error: e.error } : {})
          }
        }
      }))
      return
    }
    if (e.status === 'skipped') {
      set((prev) => ({
        jobId: e.jobId,
        items: { ...prev.items, [e.index]: { status: 'skipped', percent: 0 } }
      }))
      return
    }
    // probing | rendering — live progress for the active item.
    set((prev) => ({
      jobId: e.jobId,
      activeIndex: e.index,
      items: {
        ...prev.items,
        [e.index]: {
          status: e.status === 'probing' ? 'probing' : 'rendering',
          percent: e.percent ?? prev.items[e.index]?.percent ?? 0,
          ...(e.stage ? { stage: e.stage } : {})
        }
      }
    }))
  }
}))

/** Subscribe once at app mount; returns the unsubscribe. */
export function subscribeBatchProgress(): Unsubscribe {
  return window.shortz.onBatchProgress((e) => useBatchStore.getState().applyEvent(e))
}
