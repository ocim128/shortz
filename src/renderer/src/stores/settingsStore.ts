import { create } from 'zustand'
import type { Settings } from '../../../preload/api'

/**
 * settingsStore — mirrors settings.json (docs/technical/data-storage.md).
 */

interface SettingsStoreState {
  settings: Settings | null
  loading: boolean
  load: () => Promise<void>
  save: (next: Settings) => Promise<void>
}

export const useSettingsStore = create<SettingsStoreState>((set) => ({
  settings: null,
  loading: false,
  load: async () => {
    set({ loading: true })
    try {
      const settings = await window.shortz.getSettings()
      set({ settings })
    } finally {
      set({ loading: false })
    }
  },
  save: async (next) => {
    const saved = await window.shortz.saveSettings(next)
    set({ settings: saved })
  }
}))
