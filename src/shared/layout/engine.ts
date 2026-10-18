import { resolveKnobValues, type KnobId } from '../template/knob-registry'
import type { BackgroundStyle, Template, TextSlot, VideoSlot } from '../template/types'
import { centerOffset, containFit, inkExtent, roundPixel } from './geometry'
import {
  ascentPx,
  fontKeyFor,
  measureAdvance,
  wrapAndShrink,
  type FontKey,
  type FontLoader
} from './text'

export interface UserValues {
  fields: Record<string, string>
  knobs: Partial<Record<KnobId, unknown>>
}

export interface ClipInfo {
  /** Display (rotation-normalized) dimensions of the source clip. */
  width: number
  height: number
  durationSec?: number
}

export interface ResolvedVideo {
  x: number
  y: number
  w: number
  h: number
  cornerRadius: number
  borderWidth: number
  borderColor: string
}

export interface ResolvedText {
  slotId: string
  lines: string[]
  x: number
  y: number
  width: number
  fontFamily: 'inter' | 'poppins'
  fontWeight: number
  fontKey: FontKey
  fontSize: number
  lineHeightPx: number
  ascentPx: number
  color: string
  align: 'left' | 'center' | 'right'
  tStart?: number
  tEnd?: number
}

export interface ResolvedLayout {
  canvas: {
    width: number
    height: number
    background: BackgroundStyle
    blur?: { sigma: number; darken: number }
  }
  video: ResolvedVideo
  texts: ResolvedText[]
  warnings: string[]
}

export type LayoutErrorCode =
  'text-too-long' | 'missing-input' | 'invalid-template' | 'unsupported-fit'

export class LayoutError extends Error {
  readonly code: LayoutErrorCode
  readonly slotId?: string

  constructor(code: LayoutErrorCode, message: string, slotId?: string) {
    super(message)
    this.name = 'LayoutError'
    this.code = code
    this.slotId = slotId
  }
}

export const BACKGROUND_COLORS: Record<Exclude<BackgroundStyle, 'blurVideo'>, string> = {
  black: '#000000',
  white: '#FFFFFF',
  darkGray: '#0F0F0F'
}

/** FFmpeg `color=` literal for a style; null for blurVideo (no solid color). */
export function backgroundColorHex(style: BackgroundStyle): string | null {
  if (style === 'blurVideo') return null
  return BACKGROUND_COLORS[style]
}

/** Text ink is warned about when it reaches past this x (right action rail at 940). */
export const RIGHT_RAIL_INK_LIMIT = 920

export interface ResolveLayoutInput {
  template: Template
  values: UserValues
  clip: ClipInfo
  loadFont: FontLoader
}

export function resolveLayout(input: ResolveLayoutInput): ResolvedLayout {
  const { template, values, clip, loadFont } = input
  const warnings: string[] = []

  const { values: knobs, warnings: knobWarnings } = resolveKnobValues(template.knobs, values.knobs)
  warnings.push(...knobWarnings)

  // A knob only overrides slot/template fields when the template declares it;
  // otherwise the template's own values are authoritative.
  const declared = (id: KnobId): boolean => template.knobs.some((k) => k.id === id)

  // Required inputs must have values at resolve time (rule 4).
  for (const field of template.inputs) {
    if (field.required && (values.fields[field.key] ?? '').trim().length === 0) {
      throw new LayoutError('missing-input', `Input "${field.key}" is required`, field.key)
    }
  }

  const canvasWidth = template.canvas.width
  const canvasHeight = template.canvas.height
  const background = declared('backgroundStyle')
    ? (knobs.backgroundStyle as BackgroundStyle)
    : template.canvas.backgroundStyle

  const videoSlot = template.slots.find((s): s is VideoSlot => s.type === 'video')
  if (!videoSlot) {
    throw new LayoutError('invalid-template', 'Template has no video slot')
  }
  if (videoSlot.fit === 'cover') {
    // T1 uses contain; cover needs crop semantics in the arg builder (not in v1).
    warnings.push(`Video slot "${videoSlot.id}" uses fit "cover" which renders as contain in v1`)
  }

  // --- Video -----------------------------------------------------------------
  const videoTop = declared('videoTop') ? (knobs.videoTop as number) : videoSlot.y
  const videoScale = declared('videoScale') ? (knobs.videoScale as number) : videoSlot.scale
  const cornerRadius = declared('videoCornerRadius')
    ? (knobs.videoCornerRadius as number)
    : videoSlot.cornerRadius

  // Scale insets the bounded target box symmetrically; the content is then
  // contained inside, horizontally centered, top-aligned at the box origin
  // (normative: 16:9 -> 1080x608 at y 520, bottom lands at 1128).
  const boxW = videoSlot.width * videoScale
  const boxH = videoSlot.height * videoScale
  const boxX = videoSlot.x + centerOffset(videoSlot.width, boxW)
  const boxY = videoTop + centerOffset(videoSlot.height, boxH)

  const fit = containFit(clip.width, clip.height, boxW, boxH)
  const video: ResolvedVideo = {
    x: boxX + centerOffset(boxW, fit.width),
    y: boxY,
    w: fit.width,
    h: fit.height,
    cornerRadius,
    borderWidth: videoSlot.borderWidth,
    borderColor: videoSlot.borderColor
  }

  // --- Text ------------------------------------------------------------------
  const texts: ResolvedText[] = []

  for (const slot of template.slots) {
    if (slot.type !== 'text') continue
    const textSlot = slot as TextSlot
    if (textSlot.visible === false) continue

    const raw = values.fields[textSlot.bindsTo] ?? ''
    const text = raw.trim()
    if (text.length === 0) continue

    const textAlign = declared('textAlign')
      ? (knobs.textAlign as ResolvedText['align'])
      : textSlot.align
    const textFont = declared('textFont')
      ? (knobs.textFont as 'inter' | 'poppins')
      : textSlot.fontFamily
    const textMaxLines = declared('textMaxLines')
      ? (knobs.textMaxLines as number)
      : textSlot.maxLines

    const fontKey = fontKeyFor(textFont, textSlot.fontWeight)
    const result = wrapAndShrink({
      loader: loadFont,
      fontKey,
      text,
      maxWidth: textSlot.width,
      fontSize: textSlot.fontSize,
      fontSizeMin: textSlot.fontSizeMin,
      maxLines: textMaxLines,
      wordBreak: textSlot.wordBreak
    })

    if (!result) {
      throw new LayoutError(
        'text-too-long',
        `Text for slot "${textSlot.id}" exceeds ${textMaxLines} lines at the minimum size`,
        textSlot.id
      )
    }

    const lineHeightPx = result.fontSize * textSlot.lineHeight
    const blockHeight = result.lines.length * lineHeightPx

    let y: number
    if (textSlot.anchor.kind === 'aboveVideo') {
      const bottom = video.y - textSlot.anchor.gap
      const targetTop = bottom - blockHeight
      y = Math.max(textSlot.anchor.minY, targetTop)
      if (y > targetTop) {
        warnings.push(
          `Text slot "${textSlot.id}" clamped to minY ${textSlot.anchor.minY} (needs ${roundPixel(blockHeight)}px, room is ${roundPixel(bottom - textSlot.anchor.minY)}px)`
        )
      }
      if (y + blockHeight > video.y) {
        warnings.push(`Text slot "${textSlot.id}" overlaps the video area`)
      }
    } else {
      const boxTop = textSlot.anchor.y
      const boxHeight = textSlot.anchor.height
      if (textSlot.vAlign === 'top') y = boxTop
      else if (textSlot.vAlign === 'middle') y = boxTop + (boxHeight - blockHeight) / 2
      else y = boxTop + boxHeight - blockHeight
      if (blockHeight > boxHeight) {
        warnings.push(`Text slot "${textSlot.id}" block exceeds its fixed box`)
      }
    }
    y = roundPixel(y)

    // Safe-zone ink checks (non-fatal).
    if (y < template.safeZones.top) {
      warnings.push(
        `Text slot "${textSlot.id}" ink enters the top safe zone (y ${y} < ${template.safeZones.top})`
      )
    }
    if (y + blockHeight > canvasHeight - template.safeZones.bottom) {
      warnings.push(`Text slot "${textSlot.id}" ink enters the bottom caption zone`)
    }
    for (const line of result.lines) {
      const ink = measureAdvance(loadFont, fontKey, line, result.fontSize)
      const extent = inkExtent(textSlot.x, textSlot.width, ink, textAlign)
      if (extent.right > RIGHT_RAIL_INK_LIMIT) {
        warnings.push(
          `Text slot "${textSlot.id}" ink reaches x ${roundPixel(extent.right)} (right rail starts at 940)`
        )
        break
      }
    }
    if (result.shrunkToFloor) {
      warnings.push(
        `Text slot "${textSlot.id}" was shrunk to the minimum size (${result.fontSize}px)`
      )
    }

    texts.push({
      slotId: textSlot.id,
      lines: result.lines,
      x: textSlot.x,
      y,
      width: textSlot.width,
      fontFamily: textFont,
      fontWeight: textSlot.fontWeight,
      fontKey,
      fontSize: result.fontSize,
      lineHeightPx,
      ascentPx: ascentPx(loadFont, fontKey, result.fontSize),
      color: textSlot.color,
      align: textAlign,
      ...(textSlot.tStart !== undefined ? { tStart: textSlot.tStart } : {}),
      ...(textSlot.tEnd !== undefined ? { tEnd: textSlot.tEnd } : {})
    })
  }

  return {
    canvas: {
      width: canvasWidth,
      height: canvasHeight,
      background,
      ...(template.canvas.blur
        ? { blur: { sigma: template.canvas.blur.sigma, darken: template.canvas.blur.darken } }
        : {})
    },
    video,
    texts,
    warnings: dedupe(warnings)
  }
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items))
}
