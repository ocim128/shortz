import { useEffect, useRef } from 'react'
import { canvasFontFamilySpec, type SharedResolvedLayout } from '../preview/canvas-spec'
import { getFontLoader } from '../preview/font-loader'
import { ascentPx } from '../../../shared/layout/text'

/**
 * TextLayer — a canvas painted with the resolved layout's text, using the
 * renderer's registered CSS fonts. This mirrors the render pipeline's overlay
 * drawing exactly (src/core/render/overlay.ts drawing text): baseline =
 * y + i * lineHeightPx + ascentPx, anchored at the slot's x/width with the
 * same align semantics — preview↔render parity (goal G3, acceptance A2).
 *
 * The lines are pre-broken by the shared engine; nothing re-wraps. The canvas
 * is drawn in design space (1080×1920) and inherits the design-root scale.
 */
export function TextLayer({ layout }: { layout: SharedResolvedLayout }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const loader = getFontLoader()
    for (const text of layout.texts) {
      ctx.fillStyle = text.color
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = text.align === 'center' ? 'center' : text.align === 'right' ? 'right' : 'left'
      ctx.font = canvasFontFamilySpec(text.fontFamily, text.fontWeight, text.fontSize)
      if (text.shadow === true) {
        // Mirrors the render overlay's drop shadow for hooks on the video.
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

      // Per-line: baseline = slot y + i * lineHeightPx + ascentPx (opentype metrics,
      // same math and same font bytes the overlay PNG uses in the render pipeline).
      const ascent = ascentPx(loader, text.fontKey, text.fontSize)
      for (let i = 0; i < text.lines.length; i += 1) {
        const baseline = text.y + i * text.lineHeightPx + ascent
        ctx.fillText(text.lines[i] as string, anchorX, baseline)
      }
    }
  }, [layout])

  return <canvas ref={ref} width={1080} height={1920} className="text-canvas" aria-hidden />
}
