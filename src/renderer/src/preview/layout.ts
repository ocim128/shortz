/**
 * PLACEHOLDER preview layout.
 *
 * Computes the same geometry the shared Layout Engine will produce
 * (docs/technical/template-schema.md §"Resolution contract"): bounded video
 * target box with contain-fit, aboveVideo text anchoring. TODO(integration):
 * replace with src/shared/layout/engine.ts `resolve()` once Agent A lands it —
 * the ResolvedLayout shape is mirrored here so the components don't change.
 */

import type { BackgroundStyle, TextSlotStyle, VideoSlotGeometry } from '../../../preload/api'
import { roundEven } from '../lib/format'
import { cssFontFamily, fitText, type FittedText } from './text'

export const DESIGN_W = 1080
export const DESIGN_H = 1920
/** Phone frame on screen ≈ 390×693 (ui-spec §preview). */
export const PREVIEW_SCALE = 390 / 1080

export interface ResolvedText {
  slotId: string
  fitted: FittedText
  text: string
  /** First line's top-left, design space. */
  x: number
  y: number
  width: number
  lineHeightPx: number
  slot: TextSlotStyle
}

export interface ResolvedLayout {
  canvas: { width: number; height: number; background: BackgroundStyle }
  video: { x: number; y: number; w: number; h: number; cornerRadius: number }
  texts: ResolvedText[]
  warnings: string[]
}

export interface ClipLike {
  width: number
  height: number
}

function knobNumber(knobs: Record<string, unknown>, id: string): number | undefined {
  const v = knobs[id]
  return typeof v === 'number' ? v : undefined
}

function knobString(knobs: Record<string, unknown>, id: string): string | undefined {
  const v = knobs[id]
  return typeof v === 'string' ? v : undefined
}

/** Contain-fit source (w×h) into a target box, centered, even-rounded dims. */
function containFit(box: { x: number; y: number; w: number; h: number }, clip: ClipLike): { x: number; y: number; w: number; h: number } {
  if (clip.width <= 0 || clip.height <= 0) return { ...box, w: 0, h: 0 }
  const sourceAspect = clip.width / clip.height
  const boxAspect = box.w / box.h
  let w: number
  let h: number
  if (sourceAspect > boxAspect) {
    w = box.w
    h = roundEven(box.w / sourceAspect)
  } else {
    h = box.h
    w = roundEven(box.h * sourceAspect)
  }
  return {
    x: box.x + Math.round((box.w - w) / 2),
    y: box.y + Math.round((box.h - h) / 2),
    w,
    h
  }
}

export function resolveLayout(
  body: {
    canvas: { backgroundStyle: BackgroundStyle }
    videoSlot: VideoSlotGeometry
    textSlots: TextSlotStyle[]
  },
  values: { fields: Record<string, string>; knobs: Record<string, unknown> },
  clip: ClipLike | null
): ResolvedLayout {
  const warnings: string[] = []

  const videoTop = knobNumber(values.knobs, 'videoTop') ?? body.videoSlot.y
  const cornerRadius = knobNumber(values.knobs, 'videoCornerRadius') ?? body.videoSlot.cornerRadius
  const background = (knobString(values.knobs, 'backgroundStyle') as BackgroundStyle | undefined) ?? body.canvas.backgroundStyle

  const videoBox = { x: body.videoSlot.x, y: videoTop, w: body.videoSlot.width, h: body.videoSlot.height }
  const video = clip
    ? { ...containFit(videoBox, clip), cornerRadius }
    : { ...videoBox, w: 0, h: 0, cornerRadius }

  const textAlignOverride = knobString(values.knobs, 'textAlign')

  const texts: ResolvedText[] = body.textSlots.map((slot) => {
    const raw = values.fields[slot.bindsTo] ?? ''
    const text = raw.length > 0 ? raw : ''
    const fitted = fitText(text, slot)
    if (fitted.tooLong) {
      warnings.push(`Text does not fit ${slot.maxLines} lines even at ${slot.fontSizeMin}px`)
    } else if (fitted.shrunk) {
      warnings.push(`Text shrunk to ${fitted.fontSize}px to fit ${slot.maxLines} lines`)
    }
    const lineHeightPx = Math.round(fitted.fontSize * slot.lineHeight)
    const blockHeight = fitted.lines.length * lineHeightPx

    let boxTop: number
    let boxHeight: number
    if (slot.anchor.kind === 'aboveVideo') {
      const bottom = videoBox.y - slot.anchor.gap
      boxTop = Math.max(slot.anchor.minY, bottom - Math.max(blockHeight, 120))
      boxHeight = bottom - boxTop
    } else {
      boxTop = slot.anchor.y
      boxHeight = slot.anchor.height
    }

    // vAlign inside the resolved box.
    let firstLineY = boxTop
    if (slot.vAlign === 'bottom') firstLineY = boxTop + boxHeight - blockHeight
    else if (slot.vAlign === 'middle') firstLineY = boxTop + (boxHeight - blockHeight) / 2

    return {
      slotId: slot.bindsTo,
      fitted,
      text,
      x: slot.x,
      y: Math.round(firstLineY),
      width: slot.width,
      lineHeightPx,
      slot: textAlignOverride ? { ...slot, align: textAlignOverride as 'left' | 'center' | 'right' } : slot
    }
  })

  return {
    canvas: { width: DESIGN_W, height: DESIGN_H, background },
    video,
    texts,
    warnings
  }
}

export { cssFontFamily }
