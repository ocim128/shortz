import { useEffect, useRef } from 'react'
import type { ResolvedLayout } from '../../../shared/layout/engine'
import { drawLayoutTexts, type LayoutTextCtx } from '../../../shared/layout/draw-text'

/** Font families registered by preview/font-loader.ts (FontFace API). */
function previewFontFamily(family: 'inter' | 'poppins'): string {
  return family === 'poppins'
    ? "'ShortZ Poppins', 'Poppins', system-ui, sans-serif"
    : "'ShortZ Inter', Inter, system-ui, sans-serif"
}

/**
 * TextLayer — a canvas painted with the resolved layout's text via the SHARED
 * draw loop (src/shared/layout/draw-text.ts), the exact same rasterizer steps
 * the render pipeline's overlay PNG performs — preview↔render parity (goal G3,
 * acceptance A2). The lines are pre-broken by the shared engine; nothing
 * re-wraps. The canvas is drawn in design space (1080×1920) and inherits the
 * design-root scale.
 */
export function TextLayer({ layout }: { layout: ResolvedLayout }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    drawLayoutTexts(
      ctx as unknown as LayoutTextCtx,
      layout,
      (text) => `${text.fontWeight} ${text.fontSize}px ${previewFontFamily(text.fontFamily)}`
    )
  }, [layout])

  return <canvas ref={ref} width={1080} height={1920} className="text-canvas" aria-hidden />
}
