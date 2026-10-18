/**
 * Renderer-side font loading via the documented IPC path: bytes arrive from
 * `window.shortz.getFontBuffer` — no fetch/asset URLs in the sandbox
 * (docs/technical/project-structure.md §renderer layout tree).
 *
 * Registers CSS families 'ShortZ Inter' / 'ShortZ Poppins' once Agent A's
 * bundled TTFs exist in resources/fonts/. Until then registration fails
 * silently and the CSS falls back to system fonts. TODO(integration): the
 * same buffers also feed src/shared's opentype.js loader for real metrics.
 */

import type { FontKey } from '../../../preload/api'

const FACES: Array<{ key: FontKey; family: string; weight: number }> = [
  { key: 'inter-regular', family: 'ShortZ Inter', weight: 400 },
  { key: 'inter-semibold', family: 'ShortZ Inter', weight: 600 },
  { key: 'inter-extrabold', family: 'ShortZ Inter', weight: 800 },
  { key: 'poppins-semibold', family: 'ShortZ Poppins', weight: 600 }
]

let loadPromise: Promise<void> | null = null

export function loadBundledFonts(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    for (const face of FACES) {
      try {
        const bytes = await window.shortz.getFontBuffer(face.key)
        if (bytes.byteLength === 0) continue
        const fontFace = new FontFace(face.family, bytes.buffer as ArrayBuffer, {
          weight: String(face.weight),
          style: 'normal'
        })
        await fontFace.load()
        document.fonts.add(fontFace)
      } catch {
        // Fonts not bundled yet (engine pending) — CSS falls back to system-ui.
      }
    }
  })()
  return loadPromise
}
