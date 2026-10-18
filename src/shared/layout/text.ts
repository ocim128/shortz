import { parse } from 'opentype.js'

/**
 * Font keys address the bundled TTFs (resources/fonts). The host process injects
 * the bytes; src/shared never touches the filesystem or any platform API.
 */
export type FontKey = 'inter-400' | 'inter-600' | 'inter-800' | 'poppins-600'

export type FontLoader = (key: FontKey) => ArrayBuffer

export interface FontMetrics {
  unitsPerEm: number
  ascender: number
  descender: number
}

/** Cache is keyed by loader identity so different hosts/tests never share stale fonts. */
const fontCache = new Map<FontLoader, Map<FontKey, ReturnType<typeof parse>>>()

export function clearFontCache(): void {
  fontCache.clear()
}

function getFont(loader: FontLoader, key: FontKey): ReturnType<typeof parse> {
  let byKey = fontCache.get(loader)
  if (!byKey) {
    byKey = new Map()
    fontCache.set(loader, byKey)
  }
  const cached = byKey.get(key)
  if (cached) return cached
  const buffer = loader(key)
  if (!buffer || (buffer as ArrayBuffer).byteLength === 0) {
    throw new Error(`Font "${key}" could not be loaded (empty buffer)`)
  }
  const font = parse(buffer)
  byKey.set(key, font)
  return font
}

export function fontMetrics(loader: FontLoader, key: FontKey): FontMetrics {
  const font = getFont(loader, key)
  return {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender
  }
}

/** Distance from the text-box top to the first baseline for a given font size. */
export function ascentPx(loader: FontLoader, key: FontKey, fontSize: number): number {
  const m = fontMetrics(loader, key)
  return (m.ascender / m.unitsPerEm) * fontSize
}

export function measureAdvance(
  loader: FontLoader,
  key: FontKey,
  text: string,
  fontSize: number
): number {
  if (text.length === 0) return 0
  const font = getFont(loader, key)
  return font.getAdvanceWidth(text, fontSize, { kerning: true })
}

export function fontKeyFor(family: 'inter' | 'poppins', weight: number): FontKey {
  if (family === 'poppins') {
    // Only Poppins SemiBold is bundled; weights 400/800 fall back to it.
    return 'poppins-600'
  }
  if (weight >= 800) return 'inter-800'
  if (weight >= 600) return 'inter-600'
  return 'inter-400'
}

function splitLongWord(
  loader: FontLoader,
  key: FontKey,
  word: string,
  fontSize: number,
  maxWidth: number
): string[] {
  const chunks: string[] = []
  let current = ''
  for (const char of Array.from(word)) {
    const candidate = current + char
    if (current.length > 0 && measureAdvance(loader, key, candidate, fontSize) > maxWidth) {
      chunks.push(current)
      current = char
    } else {
      current = candidate
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/**
 * Greedy word wrap using opentype.js advances. Explicit newlines in the input
 * are preserved as paragraph boundaries; an empty paragraph yields an empty line.
 */
export function wrapText(
  loader: FontLoader,
  key: FontKey,
  text: string,
  fontSize: number,
  maxWidth: number,
  wordBreak: 'normal' | 'break-word'
): string[] {
  const lines: string[] = []
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n')

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/[ \t]+/).filter((w) => w.length > 0)
    if (words.length === 0) {
      lines.push('')
      continue
    }

    let current = ''
    const flush = (): void => {
      if (current.length > 0) {
        lines.push(current)
        current = ''
      }
    }

    for (const word of words) {
      const candidate = current.length > 0 ? `${current} ${word}` : word
      if (measureAdvance(loader, key, candidate, fontSize) <= maxWidth) {
        current = candidate
        continue
      }
      if (current.length > 0) {
        flush()
      }
      // The word alone may still overflow.
      if (measureAdvance(loader, key, word, fontSize) <= maxWidth) {
        current = word
      } else if (wordBreak === 'break-word') {
        const chunks = splitLongWord(loader, key, word, fontSize, maxWidth)
        for (let i = 0; i < chunks.length - 1; i += 1) {
          lines.push(chunks[i] as string)
        }
        current = chunks[chunks.length - 1] ?? ''
      } else {
        current = word
      }
    }
    flush()
  }

  return lines
}

export interface WrapShrinkResult {
  lines: string[]
  fontSize: number
  /** final size equals fontSizeMin and the text fills maxLines exactly or beyond */
  shrunkToFloor: boolean
}

export interface WrapShrinkOptions {
  loader: FontLoader
  fontKey: FontKey
  text: string
  maxWidth: number
  fontSize: number
  fontSizeMin: number
  maxLines: number
  wordBreak: 'normal' | 'break-word'
}

/**
 * Normative shrink-to-fit: step down 2px at a time until the text fits maxLines
 * or the floor is reached. Returns null when even the floor cannot fit.
 */
export function wrapAndShrink(options: WrapShrinkOptions): WrapShrinkResult | null {
  const { loader, fontKey, text, maxWidth, maxLines, wordBreak } = options
  let size = options.fontSize
  let lines = wrapText(loader, fontKey, text, size, maxWidth, wordBreak)

  while (lines.length > maxLines && size > options.fontSizeMin) {
    size = Math.max(options.fontSizeMin, size - 2)
    lines = wrapText(loader, fontKey, text, size, maxWidth, wordBreak)
  }

  if (lines.length > maxLines) return null

  return {
    lines,
    fontSize: size,
    shrunkToFloor: size <= options.fontSizeMin && options.fontSizeMin < options.fontSize
  }
}
