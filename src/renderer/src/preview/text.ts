/**
 * PLACEHOLDER text metrics.
 *
 * The spec (docs/technical/template-schema.md §"Text measurement", normative)
 * requires opentype.js glyph-advance metrics from the bundled TTFs, injected
 * via `loadFont(key)`. That module is Agent A's src/shared/layout/text.ts —
 * until it exists, this canvas-measureText stand-in keeps the preview and the
 * line/char counters alive. Swap at integration; the DOM consumes pre-broken
 * per-line spans either way, so no component changes.
 */

import type { TextSlotStyle } from '../../../preload/api'

let ctx: CanvasRenderingContext2D | null = null

function measureCtx(): CanvasRenderingContext2D {
  if (!ctx) {
    const canvas = document.createElement('canvas')
    ctx = canvas.getContext('2d')
  }
  return ctx!
}

export function cssFontFamily(fontFamily: 'inter' | 'poppins'): string {
  // 'ShortZ …' families are registered at runtime by preview/font-loader.ts
  // once the bundled TTFs exist; falls back to the system stack until then.
  return fontFamily === 'poppins' ? "'ShortZ Poppins', 'Poppins', system-ui, sans-serif" : "'ShortZ Inter', Inter, system-ui, sans-serif"
}

export function cssFont(weight: number, sizePx: number, fontFamily: 'inter' | 'poppins'): string {
  return `${weight} ${sizePx}px ${cssFontFamily(fontFamily)}`
}

/** Word-wrap into maxWidthPx at the given size. Honors explicit newlines. */
export function wrapText(text: string, maxWidthPx: number, weight: number, sizePx: number, fontFamily: 'inter' | 'poppins'): string[] {
  const c = measureCtx()
  c.font = cssFont(weight, sizePx, fontFamily)
  const lines: string[] = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0)
    if (words.length === 0) {
      lines.push('')
      continue
    }
    let current = ''
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word
      if (c.measureText(candidate).width <= maxWidthPx || !current) {
        current = candidate
      } else {
        lines.push(current)
        current = word
      }
    }
    if (current) lines.push(current)
  }
  return lines
}

export interface FittedText {
  lines: string[]
  fontSize: number
  shrunk: boolean
  tooLong: boolean
}

/**
 * Shrink-to-fit — the documented algorithm: decrease by 2px until the text
 * fits maxLines or hits fontSizeMin; still over at the floor = tooLong.
 */
export function fitText(text: string, slot: TextSlotStyle): FittedText {
  let size = slot.fontSize
  let lines = wrapText(text, slot.width, slot.fontWeight, size, slot.fontFamily)
  let shrunk = false
  while (lines.length > slot.maxLines && size > slot.fontSizeMin) {
    size -= 2
    shrunk = true
    lines = wrapText(text, slot.width, slot.fontWeight, size, slot.fontFamily)
  }
  return { lines, fontSize: size, shrunk, tooLong: lines.length > slot.maxLines }
}
