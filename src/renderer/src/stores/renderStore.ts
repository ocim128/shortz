import { create } from 'zustand'
import type { ExportResult, RenderProgressEvent, Unsubscribe } from '../../../preload/api'

/**
 * renderStore — active export job, progress, result (docs/technical/ui-spec.md
 * §store slices). The engine is mocked for now: status stays 'idle' unless
 * the real orchestrator events arrive over onRenderProgress.
 */

export type RenderStatus = 'idle' | 'running' | 'done' | 'error'

interface RenderStoreState {
  status: RenderStatus
  progress: RenderProgressEvent | null
  result: ExportResult | null
  error: string | null
  start: () => void
  reset: () => void
  applyProgress: (e: RenderProgressEvent) => void
}

export const useRenderStore = create<RenderStoreState>((set) => ({
  status: 'idle',
  progress: null,
  result: null,
  error: null,
  start: () => set({ status: 'running', progress: null, result: null, error: null }),
  reset: () => set({ status: 'idle', progress: null, result: null, error: null }),
  applyProgress: (e) => {
    if (e.error) {
      set({ status: 'error', error: e.error, progress: e })
      return
    }
    if (e.done) {
      set({ status: 'idle', progress: null })
      return
    }
    set({ status: 'running', progress: e })
  }
}))

/** Subscribe once at app mount; returns the unsubscribe. */
export function subscribeRenderProgress(): Unsubscribe {
  return window.shortz.onRenderProgress((e) => useRenderStore.getState().applyProgress(e))
}
