import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { backgroundColorHex, type ResolvedLayout } from '../../shared/layout/engine'
import { drawLayoutTexts, type LayoutTextCtx } from '../../shared/layout/draw-text'
import { canvasFontSpec } from './fonts'

export interface OverlayAssets {
  overlayPng: Buffer
  /** Present only for blur background + rounded corners (alphamerge case). */
  maskPng?: Buffer
}

/** The mask path is required when the background is not solid but corners are rounded. */
export function needsMask(layout: ResolvedLayout): boolean {
  return layout.canvas.background === 'blurVideo' && layout.video.cornerRadius > 0
}

function drawCornerCovers(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: string
): void {
  const r = Math.min(radius, Math.floor(Math.min(w, h) / 2))
  if (r <= 0) return
  ctx.fillStyle = color

  // Top-left: square minus the quarter disk.
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x + r, y)
  ctx.arc(x + r, y + r, r, -Math.PI / 2, Math.PI, true)
  ctx.closePath()
  ctx.fill()

  // Top-right
  ctx.beginPath()
  ctx.moveTo(x + w - r, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + r)
  ctx.arc(x + w - r, y + r, r, 0, -Math.PI / 2, true)
  ctx.closePath()
  ctx.fill()

  // Bottom-left
  ctx.beginPath()
  ctx.moveTo(x, y + h - r)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  ctx.closePath()
  ctx.fill()

  // Bottom-right
  ctx.beginPath()
  ctx.moveTo(x + w, y + h - r)
  ctx.lineTo(x + w, y + h)
  ctx.lineTo(x + w - r, y + h)
  ctx.arc(x + w - r, y + h - r, r, Math.PI / 2, 0, true)
  ctx.closePath()
  ctx.fill()
}

function roundedRectPath(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  const r = Math.min(radius, Math.floor(Math.min(w, h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.arc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  ctx.lineTo(x + w, y + h - r)
  ctx.arc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  ctx.lineTo(x + r, y + h)
  ctx.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  ctx.lineTo(x, y + r)
  ctx.arc(x + r, y + r, r, Math.PI, (Math.PI * 3) / 2, false)
  ctx.closePath()
}

/**
 * Draw all non-video slots into a transparent full-canvas PNG. Text goes
 * through the SHARED draw loop (src/shared/layout/draw-text.ts) — the same
 * one the renderer's preview canvas uses — consuming only the pre-broken
 * lines from the shared opentype.js metrics.
 */
export function renderOverlayAssets(layout: ResolvedLayout): OverlayAssets {
  const { width, height } = layout.canvas
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  // Rounded corners on solid backgrounds: background-colored corner covers.
  if (layout.canvas.background !== 'blurVideo' && layout.video.cornerRadius > 0) {
    const color = backgroundColorHex(layout.canvas.background) ?? '#000000'
    drawCornerCovers(
      ctx,
      layout.video.x,
      layout.video.y,
      layout.video.w,
      layout.video.h,
      layout.video.cornerRadius,
      color
    )
  }

  // Optional border stroke (no-op for Template 1 defaults).
  if (layout.video.borderWidth > 0) {
    ctx.strokeStyle = layout.video.borderColor
    ctx.lineWidth = layout.video.borderWidth
    const inset = layout.video.borderWidth / 2
    roundedRectPath(
      ctx,
      layout.video.x + inset,
      layout.video.y + inset,
      layout.video.w - layout.video.borderWidth,
      layout.video.h - layout.video.borderWidth,
      layout.video.cornerRadius
    )
    ctx.stroke()
  }

  drawLayoutTexts(
    ctx as unknown as LayoutTextCtx,
    layout,
    (text) => canvasFontSpec(text.fontKey, text.fontSize)
  )

  const assets: OverlayAssets = { overlayPng: canvas.toBuffer('image/png') }
  if (needsMask(layout)) {
    assets.maskPng = renderMaskPng(layout.video.w, layout.video.h, layout.video.cornerRadius)
  }
  return assets
}

/**
 * White rounded rect on black at exactly the video content dimensions —
 * alphamerge takes this luma as the video's alpha and requires equal sizes.
 */
export function renderMaskPng(width: number, height: number, cornerRadius: number): Buffer {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = '#FFFFFF'
  roundedRectPath(ctx, 0, 0, width, height, cornerRadius)
  ctx.fill()
  return canvas.toBuffer('image/png')
}
