import type { ResolvedLayout, ResolvedText } from './engine'

/**
 * The ONE text rasterizer loop for both canvas dialects — the render
 * pipeline's overlay PNG (@napi-rs/canvas) and the renderer's preview canvas
 * (DOM canvas). Both contexts implement the same Canvas2D surface; the small
 * structural interface below keeps this module platform-free, and each caller
 * supplies its own font-spec string (registered-family names differ per tier).
 *
 * Baseline math: y + i * lineHeightPx + ascentPx, anchored at the slot's
 * x/width with the engine's align semantics — the lines are pre-broken by the
 * shared metrics engine; nothing re-wraps or re-measures here.
 */
export interface LayoutTextCtx {
  font: string
  fillStyle: string
  textBaseline: string
  textAlign: 'left' | 'center' | 'right'
  shadowColor: string
  shadowBlur: number
  shadowOffsetY: number
  fillText(text: string, x: number, y: number): void
}

export function drawLayoutTexts(
  ctx: LayoutTextCtx,
  layout: ResolvedLayout,
  fontOf: (text: ResolvedText) => string
): void {
  for (const text of layout.texts) {
    ctx.font = fontOf(text)
    ctx.fillStyle = text.color
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = text.align
    if (text.shadow === true) {
      // Hook overlays the video (smart full-bleed) — soft shadow for contrast.
      ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'
      ctx.shadowBlur = Math.max(4, text.fontSize / 7)
      ctx.shadowOffsetY = Math.max(1, Math.round(text.fontSize / 34))
    } else {
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
      ctx.shadowOffsetY = 0
    }

    const anchorX =
      text.align === 'center'
        ? text.x + text.width / 2
        : text.align === 'right'
          ? text.x + text.width
          : text.x

    for (let i = 0; i < text.lines.length; i += 1) {
      ctx.fillText(text.lines[i] as string, anchorX, text.y + i * text.lineHeightPx + text.ascentPx)
    }
  }
}
