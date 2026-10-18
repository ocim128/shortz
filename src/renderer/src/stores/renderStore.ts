import { create } from 'zustand'
import type { ExportResult, RenderProgressEvent, Unsubscribe } from '../../../preload/api'
import { useProjectStore } from './projectStore'
import { toast } from './toastStore'
import { S } from '../strings'

/**
 * renderStore — active export job, progress, result (docs/technical/ui-spec.md
 * §store slices). Progress events arrive on the 'shortz:render:progress'
 * channel (main → renderer); the job itself runs through the real orchestrator
 * over shortz:exportProject with an AbortController-backed cancel.
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
      // Pick up the fresh exportHistory written by main (and reset the dirty chip).
      try {
        const fresh = await window.shortz.openProject(project.id)
        useProjectStore.setState({ active: fresh, dirty: false })
        await useProjectStore.getState().loadList()
      } catch {
        /* reload is best-effort */
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/cancel/i.test(message)) {
        // Cancelled render: not an error; the done flow already restored idle.
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
    const { progress, status } = get()
    if (status !== 'running' || !progress) return
    await window.shortz.cancelExport(progress.jobId).catch(() => undefined)
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
