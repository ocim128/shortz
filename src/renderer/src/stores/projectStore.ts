import { create } from 'zustand'
import type { Project, ProjectMeta } from '../../../preload/api'

/**
 * projectStore — the open project doc + dirty flag (docs/technical/ui-spec.md
 * §store slices). Autosave is debounced 500 ms after any change
 * (docs/technical/data-storage.md).
 */

interface ProjectStoreState {
  list: ProjectMeta[]
  listLoading: boolean
  active: Project | null
  dirty: boolean
  loadList: () => Promise<void>
  createFromSource: (sourcePath: string) => Promise<Project>
  openProject: (id: string) => Promise<Project>
  closeActive: () => void
  /** Immutably patch the active project and schedule the autosave. */
  patchActive: (mut: (draft: Project) => void) => void
  forceSave: () => Promise<void>
}

// Autosave plumbing (module-scoped, not part of the reactive state).
let autosaveTimer: ReturnType<typeof setTimeout> | null = null
let rev = 0 // increments on every patch; guards against save-then-stale-markSaved

export const useProjectStore = create<ProjectStoreState>((set, get) => ({
  list: [],
  listLoading: false,
  active: null,
  dirty: false,

  loadList: async () => {
    set({ listLoading: true })
    try {
      const list = await window.shortz.listProjects()
      set({ list })
    } finally {
      set({ listLoading: false })
    }
  },

  createFromSource: async (sourcePath) => {
    const project = await window.shortz.createProject(sourcePath)
    rev += 1
    set({ active: project, dirty: false })
    void get().loadList()
    return project
  },

  openProject: async (id) => {
    const project = await window.shortz.openProject(id)
    rev += 1
    set({ active: project, dirty: false })
    return project
  },

  closeActive: () => {
    const { active, dirty } = get()
    if (active && dirty) void window.shortz.saveProject(active)
    set({ active: null, dirty: false })
  },

  patchActive: (mut) => {
    const current = get().active
    if (!current) return
    const draft: Project = JSON.parse(JSON.stringify(current))
    mut(draft)
    rev += 1
    set({ active: draft, dirty: true })
    scheduleAutosave(get)
  },

  forceSave: async () => {
    const { active, dirty } = get()
    if (!active || !dirty) return
    const savedRev = rev
    await window.shortz.saveProject(active)
    if (autosaveTimer) {
      clearTimeout(autosaveTimer)
      autosaveTimer = null
    }
    if (rev === savedRev) set({ dirty: false })
  }
}))

function scheduleAutosave(get: () => ProjectStoreState): void {
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    const { active, dirty } = get()
    if (!active || !dirty) return
    const savedRev = rev
    void window.shortz.saveProject(active).then(() => {
      if (rev === savedRev) useProjectStore.setState({ dirty: false })
      // A newer revision means another autosave is already scheduled.
    })
  }, 500)
}
