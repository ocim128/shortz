import type { DlEvent } from '../shared/downloader/types'

/**
 * Event coalescing for the downloader IPC (docs/twitter-downloader/technical/
 * ui-and-ipc.md §3): byte ticks arrive at whatever rate the transfer produces
 * them, so main batches them to ~10 Hz. Status transitions are sent the moment
 * they happen — a row that only moved on a 100 ms beat would look stuck.
 *
 * Electron-free on purpose: `tests/unit/downloader-ui/coalescer.test.ts` drives
 * it with a fake scheduler instead of a window.
 *
 * Ordering rule: a non-progress event flushes the pending ticks *before* it is
 * emitted. Without that, a buffered tick can land after `ok`/`failed` and drag
 * the row's status backwards. `run-done` drops the buffer instead — nothing
 * after the terminal event can be useful.
 */

export interface DlEventCoalescer {
  /** Buffer or forward one core event. */
  push: (event: DlEvent) => void
  /** Emit everything buffered now (e.g. before a teardown). */
  flush: () => void
  /** Discard buffered ticks without emitting them. */
  drop: () => void
}

export interface DlEventCoalescerOptions {
  emit: (event: DlEvent) => void
  /** Flush cadence in ms. Default 100 (≈10 Hz). */
  intervalMs?: number
  /** Injectable timer seam for tests. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  cancelSchedule?: (handle: ReturnType<typeof setTimeout>) => void
}

/** One buffer slot per media: later ticks replace earlier ones, never queue. */
function slotOf(event: DlEvent): string {
  return event.kind === 'media-progress' ? `${event.key}:${event.mediaIndex}` : ''
}

export function createDlEventCoalescer(options: DlEventCoalescerOptions): DlEventCoalescer {
  const intervalMs = options.intervalMs ?? 100
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle))

  const buffered = new Map<string, DlEvent>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const clear = (): void => {
    if (timer !== null) {
      cancelSchedule(timer)
      timer = null
    }
  }

  const flush = (): void => {
    clear()
    if (buffered.size === 0) return
    const pending = [...buffered.values()]
    buffered.clear()
    for (const event of pending) options.emit(event)
  }

  const drop = (): void => {
    clear()
    buffered.clear()
  }

  return {
    push: (event) => {
      if (event.kind === 'media-progress') {
        buffered.set(slotOf(event), event)
        if (timer === null) timer = schedule(flush, intervalMs)
        return
      }
      if (event.kind === 'run-done') {
        drop()
        options.emit(event)
        return
      }
      // item transition: flush first so no stale tick lands after it.
      flush()
      options.emit(event)
    },
    flush,
    drop
  }
}
