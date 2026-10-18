import { create } from 'zustand'

export interface ToastItem {
  id: number
  kind: 'info' | 'ok' | 'err'
  text: string
}

interface ToastStoreState {
  toasts: ToastItem[]
  push: (kind: ToastItem['kind'], text: string) => void
  dismiss: (id: number) => void
}

let nextId = 0

export const useToastStore = create<ToastStoreState>((set, get) => ({
  toasts: [],
  push: (kind, text) => {
    const id = ++nextId
    set({ toasts: [...get().toasts, { id, kind, text }] })
    setTimeout(() => get().dismiss(id), 4000)
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) })
}))

export const toast = {
  info: (text: string) => useToastStore.getState().push('info', text),
  ok: (text: string) => useToastStore.getState().push('ok', text),
  err: (text: string) => useToastStore.getState().push('err', text)
}
