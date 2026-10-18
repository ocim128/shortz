import { parse } from 'opentype.js'

/**
 * Font keys address the bundled TTFs (resources/fonts). The host process injects
 * the bytes; src/shared never touches the filesystem or any platform API.
 */
export type FontKey = 'inter-400' | 'inter-600' | 'inter-800' | 'poppins-600'

export type FontLoader = (key: FontKey) => ArrayBuffer

type ParsedFont = ReturnType<typeof parse>

/**
 * Bytes of the host platform's emoji font — the only glyph coverage the bundled
 * fonts lack that hooks actually use. Injected the same way as FontLoader
 * (hosts read the system file); null restores bundled-only metrics.
 */
export type EmojiFontSource = () => ArrayBuffer

let emojiSource: EmojiFontSource | null = null
let emojiParsed: { source: EmojiFontSource; font: ParsedFont } | null = null
let emojiFailedSource: EmojiFontSource | null = null

export function setEmojiFont(source: EmojiFontSource | null): void {
  if (emojiSource === source) return
  emojiSource = source
  emojiParsed = null
}

export interface FontMetrics {
  unitsPerEm: number
  ascender: number
  descender: number
}

/**
 * Cache is keyed by loader identity so different hosts/tests never share stale
 * fonts. It is bounded: a host that hands out a fresh loader per call would
 * otherwise pin one parsed font per invocation forever (the renderer did
 * exactly that), so the oldest host entry is evicted past the cap.
 */
const MAX_CACHED_LOADERS = 4
const fontCache = new Map<FontLoader, Map<FontKey, ReturnType<typeof parse>>>()

export function clearFontCache(): void {
  fontCache.clear()
}

/** Number of cached loader entries — exposed for leak-regression tests. */
export function fontCacheSize(): number {
  return fontCache.size
}

function getFont(loader: FontLoader, key: FontKey): ParsedFont {
  let byKey = fontCache.get(loader)
  if (!byKey) {
    if (fontCache.size >= MAX_CACHED_LOADERS) {
      const oldest = fontCache.keys().next().value
      if (oldest !== undefined) fontCache.delete(oldest)
    }
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

/** Parsed emoji font, or null when the host registered none / it failed. */
function getEmojiFont(): ParsedFont | null {
  if (!emojiSource) return null
  if (emojiFailedSource === emojiSource) return null
  if (!emojiParsed || emojiParsed.source !== emojiSource) {
    const buffer = emojiSource()
    if (!buffer || buffer.byteLength === 0) return null
    try {
      emojiParsed = { source: emojiSource, font: parse(buffer) }
    } catch {
      // A font opentype.js cannot read (e.g. some collections) would otherwise
      // throw out of every measurement — degrade to bundled-only metrics.
      emojiFailedSource = emojiSource
      return null
    }
  }
  return emojiParsed.font
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

export interface TextRun {
  text: string
  /** True when the primary font lacks the run's glyphs (emoji, symbols). */
  fallback: boolean
}

/**
 * Split text into maximal runs of covered / uncovered code points. Iterates by
 * code point so astral characters (emoji) stay whole. Exported for tests.
 */
export function splitRunsByCoverage(
  text: string,
  hasGlyph: (character: string) => boolean
): TextRun[] {
  const runs: TextRun[] = []
  for (const character of text) {
    const fallback = !hasGlyph(character)
    const last = runs[runs.length - 1]
    if (last !== undefined && last.fallback === fallback) {
      last.text += character
    } else {
      runs.push({ text: character, fallback })
    }
  }
  return runs
}

/**
 * Width of `text` at `fontSize`. When an emoji font is registered, characters
 * the primary font lacks are measured with it — run by run, mirroring how the
 * rasterizer draws a font fallback list — so wrapping and centering match what
 * lands on screen instead of measuring missing glyphs as .notdef boxes.
 *
 * Known approximation: multi-codepoint sequences (skin tones, ZWJ families)
 * measure as the sum of their parts; the shaper may ligate them narrower.
 */
export function measureAdvance(
  loader: FontLoader,
  key: FontKey,
  text: string,
  fontSize: number
): number {
  if (text.length === 0) return 0
  const font = getFont(loader, key)
  const emoji = getEmojiFont()
  if (emoji === null) {
    return font.getAdvanceWidth(text, fontSize, { kerning: true })
  }
  const runs = splitRunsByCoverage(text, (character) => font.charToGlyphIndex(character) !== 0)
  if (!runs.some((run) => run.fallback)) {
    return font.getAdvanceWidth(text, fontSize, { kerning: true })
  }
  let total = 0
  for (const run of runs) {
    const measureWith = run.fallback ? emoji : font
    total += measureWith.getAdvanceWidth(run.text, fontSize, { kerning: true })
  }
  return total
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
