export interface Size {
  width: number
  height: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Pixel rounding for all resolved boxes. The docs' examples route 607.5 -> 608
 * and 980 * 9/16 = 551.25 -> 551; odd intermediate video dimensions are safe
 * because the final composited frame is the always-even 1080x1920 canvas
 * (verified against FFmpeg 8.0 filtergraph behavior).
 */
export function roundPixel(value: number): number {
  return Math.round(value)
}

/** Minimal even rounding, kept for callers that must emit even dimensions. */
export function roundEven(value: number): number {
  return Math.round(value / 2) * 2
}

/**
 * Largest `contain` fit of srcW x srcH inside boxW x boxH (letter/pillarbox),
 * never larger than the box, at least 2px in either dimension.
 */
export function containFit(srcW: number, srcH: number, boxW: number, boxH: number): Size {
  if (srcW <= 0 || srcH <= 0 || boxW <= 0 || boxH <= 0) {
    return { width: 2, height: 2 }
  }
  const scale = Math.min(boxW / srcW, boxH / srcH)
  const width = Math.max(2, roundPixel(srcW * scale))
  const height = Math.max(2, roundPixel(srcH * scale))
  return { width, height }
}

/** Centered offset of an inner size within an outer size (rounded to whole px). */
export function centerOffset(outer: number, inner: number): number {
  return roundPixel((outer - inner) / 2)
}

export interface InkExtent {
  left: number
  right: number
}

/** Horizontal ink extent of a line given the text box and alignment. */
export function inkExtent(
  boxX: number,
  boxWidth: number,
  inkWidth: number,
  align: 'left' | 'center' | 'right'
): InkExtent {
  switch (align) {
    case 'left':
      return { left: boxX, right: boxX + inkWidth }
    case 'center': {
      const left = boxX + (boxWidth - inkWidth) / 2
      return { left, right: left + inkWidth }
    }
    case 'right':
      return { left: boxX + boxWidth - inkWidth, right: boxX + boxWidth }
  }
}
