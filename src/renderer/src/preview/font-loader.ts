/**
 * Renderer-side font loading via the documented IPC path: bytes arrive from
 * `window.shortz.getFontBuffer` — no fetch/asset URLs in the sandbox.
 *
 * The SAME cached ArrayBuffers feed both CSS FontFace registration (preview
 * rendering) and the shared opentype.js metrics engine (src/shared/layout) —
 * exactly the pairing the preview/export parity rule prescribes.
 */

import { setEmojiFont, type FontLoader, type FontKey } from '../../../shared/layout/text'

/** CSS registration metadata per bundled font (keys match the shared FontKey). */
const FACES: Array<{ key: FontKey; family: string; weight: number }> = [
  { key: 'inter-400', family: 'ShortZ Inter', weight: 400 },
  { key: 'inter-600', family: 'ShortZ Inter', weight: 600 },
  { key: 'inter-800', family: 'ShortZ Inter', weight: 800 },
  { key: 'poppins-600', family: 'ShortZ Poppins', weight: 600 }
]

const cache = new Map<FontKey, ArrayBuffer>()
let readyPromise: Promise<void> | null = null

export function loadBundledFonts(): Promise<void> {
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    await Promise.all(
      FACES.map(async (face) => {
        const bytes = await window.shortz.getFontBuffer(face.key)
        if (bytes.byteLength === 0) throw new Error(`Font ${face.key} returned empty bytes`)
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer
        cache.set(face.key, buffer)
        const fontFace = new FontFace(face.family, buffer, { weight: String(face.weight), style: 'normal' })
        await fontFace.load()
        document.fonts.add(fontFace)
      })
    )
    // Emoji metrics (best-effort): the preview's canvas draws emoji through the
    // browser's own fallback, but the shared wrapping engine needs the same
    // advances the renderer's canvas will use — fetch the system emoji font
    // when the platform has one. Failure keeps bundled-only metrics.
    try {
      const bytes = await window.shortz.getFontBuffer('emoji')
      if (bytes.byteLength > 0) {
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ) as ArrayBuffer
        setEmojiFont(() => buffer)
      }
    } catch {
      /* optional enhancement — preview still works without it */
    }
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
  cachedLoader = (key: FontKey): ArrayBuffer => {
    const buf = cache.get(key)
    if (!buf) throw new Error(`Font "${key}" is not loaded yet (fonts must be awaited first)`)
    return buf
  }
  return cachedLoader
}
