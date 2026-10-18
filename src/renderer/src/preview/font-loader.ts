/**
 * Renderer-side font loading via the documented IPC path: bytes arrive from
 * `window.shortz.getFontBuffer` — no fetch/asset URLs in the sandbox
 * (docs/technical/project-structure.md §renderer layout tree).
 *
 * The SAME cached ArrayBuffers feed both CSS FontFace registration (preview
 * rendering) and the shared opentype.js metrics engine (src/shared/layout) —
 * exactly the pairing tmp/NOTES-A.md §"Renderer preview" prescribes.
 */

import type { FontLoader, FontKey as SharedFontKey } from '../../../shared/layout/text'
import type { FontKey } from '../../../preload/api'

const FACES: Array<{ key: FontKey; family: string; weight: number; shared: SharedFontKey }> = [
  { key: 'inter-regular', family: 'ShortZ Inter', weight: 400, shared: 'inter-400' },
  { key: 'inter-semibold', family: 'ShortZ Inter', weight: 600, shared: 'inter-600' },
  { key: 'inter-extrabold', family: 'ShortZ Inter', weight: 800, shared: 'inter-800' },
  { key: 'poppins-semibold', family: 'ShortZ Poppins', weight: 600, shared: 'poppins-600' }
]

const cache = new Map<SharedFontKey, ArrayBuffer>()
let readyPromise: Promise<void> | null = null

export function loadBundledFonts(): Promise<void> {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    await Promise.all(
      FACES.map(async (face) => {
        const bytes = await window.shortz.getFontBuffer(face.key)
        if (bytes.byteLength === 0) throw new Error(`Font ${face.key} returned empty bytes`)
        cache.set(face.shared, bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer)
        const fontFace = new FontFace(face.family, bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer, { weight: String(face.weight), style: 'normal' })
        await fontFace.load()
        document.fonts.add(fontFace)
      })
    )
  })()
  return readyPromise
}

/** True once loadBundledFonts() has resolved without error. */
export function fontsReady(): boolean {
  return cache.size === FACES.length
}

/**
 * Sync loader for the shared layout engine (resolveLayout/wrapAndShrink).
 * Throws unless loadBundledFonts() has completed — gate callers on it.
 *
 * Memoized: the shared text engine caches parsed fonts per loader identity, so
 * returning a fresh closure per call would defeat that cache (one TTF parse
 * per layout) and pin every parsed font forever.
 */
let cachedLoader: FontLoader | null = null

export function getFontLoader(): FontLoader {
  if (cachedLoader) return cachedLoader
  cachedLoader = (key: SharedFontKey): ArrayBuffer => {
    const buf = cache.get(key)
    if (!buf) throw new Error(`Font "${key}" is not loaded yet (fonts must be awaited first)`)
    return buf
  }
  return cachedLoader
}
