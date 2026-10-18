import { create } from 'zustand'

/**
 * playerStore — the single <video> element's playback state. The video lives
 * in VideoLayer; everything else (PlaybackBar, TrimRange, shortcuts) goes
 * through here so the DOM element is owned by exactly one component.
 */

interface PlayerStoreState {
  el: HTMLVideoElement | null
  mediaUrl: string | null
  duration: number
  current: number
  playing: boolean
  videoWidth: number
  videoHeight: number
  ready: boolean
  error: string | null
  attach: (el: HTMLVideoElement | null) => void
  setMedia: (url: string | null) => void
  setDuration: (d: number) => void
  setCurrent: (t: number) => void
  setPlaying: (p: boolean) => void
  setVideoSize: (w: number, h: number) => void
  setReady: (r: boolean) => void
  setError: (e: string | null) => void
  toggle: () => void
  seek: (t: number) => void
}

export const usePlayerStore = create<PlayerStoreState>((set, get) => ({
  el: null,
  mediaUrl: null,
  duration: 0,
  current: 0,
  playing: false,
  videoWidth: 0,
  videoHeight: 0,
  ready: false,
  error: null,

  attach: (el) => set({ el }),
  setMedia: (url) =>
    set({ mediaUrl: url, duration: 0, current: 0, playing: false, videoWidth: 0, videoHeight: 0, ready: false, error: null }),
  setDuration: (duration) => set({ duration }),
  setCurrent: (current) => set({ current }),
  setPlaying: (playing) => set({ playing }),
  setVideoSize: (videoWidth, videoHeight) => set({ videoWidth, videoHeight }),
  setReady: (ready) => set({ ready }),
  setError: (error) => set({ error }),

  toggle: () => {
    const el = get().el
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  },

  seek: (t) => {
    const el = get().el
    if (!el) return
    el.currentTime = Math.max(0, Math.min(t, el.duration || 0))
  }
}))
