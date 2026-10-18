/// <reference types="vite/client" />
import type { ShortzApi } from '../../preload/api'

declare global {
  interface Window {
    shortz: ShortzApi
  }
}

export {}
