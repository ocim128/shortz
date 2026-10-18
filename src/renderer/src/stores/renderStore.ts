import { create } from 'zustand'
import type { ExportResult, RenderProgressEvent, Unsubscribe } from '../../../preload/api'
import { useProjectStore } from './projectStore'
import { toast } from './toastStore'
import { S } from '../strings'

/**
 * renderStore — active export job, progress, result (docs/technical/ui-spec.md
 * §store slices). Progress events arrive on the 'shortz:render:progress'
 * channel (main → renderer); the job itself runs through the real orchestrator
 * over shortz:exportProject, cancellable via main's abort controller.
 */

export type RenderStatus = 'idle' | 'running' | 'error'

interface RenderStoreState {
  status: RenderStatus
  progress: RenderProgressEvent | null
  result: ExportResult | null
  error: string | null
  runJob: () => Promise<ExportResult | null>
  cancel: () => Promise<void>
  dismiss: () => void
  applyProgress: (e: RenderProgressEvent) => void
}

export const useRenderStore = create<RenderStoreState>((set, get) => ({
  status: 'idle',
  progress: null,
  result: null,
  error: null,

  runJob: async () => {
    const project = useProjectStore.getState().active
    if (!project) return null
    if (get().status === 'running') return null
    if (project.source.missing === true) {
      toast.err(S.exportMissingSource)
      return null
    }
    set({ status: 'running', progress: null, result: null, error: null })
    try {
      const result = await window.shortz.exportProject(project, {})
      set({ status: 'idle', progress: null, result })
      toast.ok(S.exportDoneToast(result.path))
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/cancel/i.test(message)) {
        // Cancelled render: not an error.
        set({ status: 'idle', progress: null })
        toast.info(S.exportCancelled)
        return null
      }
      set({ status: 'error', error: message, progress: null })
      toast.err(S.exportFailedToast)
      return null
    }
  },

  cancel: async () => {
    if (get().status !== 'running') return
    await window.shortz.cancelExport().catch(() => undefined)
  },

  dismiss: () => set({ status: 'idle', progress: null, error: null }),

  applyProgress: (e) => {
    if (e.error) {
      set({ status: 'error', error: e.error, progress: e })
      return
    }
    if (e.done) {
      // The export promise resolution tail-drives the transition (result toast);
      // the done event just clears the bar.
      if (get().status === 'running') set({ progress: e })
      return
    }
    set({ status: 'running', progress: e })
  }
}))

/** Subscribe once at app mount; returns the unsubscribe. */
export function subscribeRenderProgress(): Unsubscribe {
  return window.shortz.onRenderProgress((e) => useRenderStore.getState().applyProgress(e))
}
