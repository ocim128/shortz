import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { GlobalFonts } from '@napi-rs/canvas'
import { logWarn } from '../log'
import { setEmojiFont, type FontKey, type FontLoader } from '../../shared/layout/text'

export const FONT_FILES: Record<FontKey, string> = {
  'inter-400': 'Inter-Regular.ttf',
  'inter-600': 'Inter-SemiBold.ttf',
  'inter-800': 'Inter-ExtraBold.ttf',
  'poppins-600': 'Poppins-SemiBold.ttf'
}

/** Registered family per key; Skia matches weights inside the Inter family. */
export const FONT_FAMILIES: Record<FontKey, string> = {
  'inter-400': 'Inter',
  'inter-600': 'Inter',
  'inter-800': 'Inter',
  'poppins-600': 'Poppins'
}

export const FONT_WEIGHTS: Record<FontKey, number> = {
  'inter-400': 400,
  'inter-600': 600,
  'inter-800': 800,
  'poppins-600': 600
}

export function fontFilePath(fontsDir: string, key: FontKey): string {
  return path.join(fontsDir, FONT_FILES[key])
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer
}

/** One loader identity per fonts directory, so the shared metrics cache
 * (`fontCache` in shared/layout/text.ts is keyed by loader identity) survives
 * across renders. renderProject used to build a fresh closure per render, which
 * re-parsed all four TTFs each time (~8.5 ms/layout measured) and, with the
 * cache capped at 4 loader entries, evicted the previous one every render. */
const fontLoaders = new Map<string, FontLoader>()

/**
 * Synchronous fs-based font loader for opentype.js metrics — used by the CLI,
 * tests, Electron main and (via injected bytes) the renderer. src/shared stays
 * platform-free; only the host supplies this function.
 */
export function createFontBufferLoader(fontsDir: string): FontLoader {
  const dirKey = path.resolve(fontsDir)
  const existing = fontLoaders.get(dirKey)
  if (existing !== undefined) return existing
  const loader: FontLoader = (key: FontKey): ArrayBuffer => {
    if (!(key in FONT_FILES)) {
      throw new Error(`Unknown font key "${String(key)}"`)
    }
    return toArrayBuffer(readFileSync(fontFilePath(fontsDir, key)))
  }
  fontLoaders.set(dirKey, loader)
  return loader
}

/** Test/diagnostic seam: how many directory loaders are memoized. */
export function fontLoaderCount(): number {
  return fontLoaders.size
}

const registered = new Set<string>()

/** Register bundled TTFs with Skia once per process (idempotent). */
export function registerFonts(fontsDir: string): void {
  for (const key of Object.keys(FONT_FILES) as FontKey[]) {
    const family = FONT_FAMILIES[key]
    const mark = `${fontsDir}|${family}|${key}`
    if (registered.has(mark)) continue
    const filePath = fontFilePath(fontsDir, key)
    const ok = GlobalFonts.registerFromPath(filePath, family)
    if (!ok) logWarn(`[fonts] could not register ${filePath}`)
    registered.add(mark)
  }
}

/** CSS-like font spec for @napi-rs/canvas ctx.font. */
export function canvasFontSpec(key: FontKey, fontSize: number): string {
  const base = `${FONT_WEIGHTS[key]} ${fontSize}px "${FONT_FAMILIES[key]}"`
  return emojiFamily !== null ? `${base}, "${emojiFamily}"` : base
}

// --- system emoji fallback ----------------------------------------------------

export interface SystemEmojiFont {
  path: string
  /** Family name to register + reference in canvasFontSpec's fallback list. */
  family: string
}

/** Known-per-platform emoji fonts, first existing file wins. */
function emojiFontCandidates(): SystemEmojiFont[] {
  if (process.platform === 'win32') {
    return [{ path: 'C:\\Windows\\Fonts\\seguiemj.ttf', family: 'Segoe UI Emoji' }]
  }
  if (process.platform === 'darwin') {
    return [
      { path: '/System/Library/Fonts/Apple Color Emoji.ttc', family: 'Apple Color Emoji' },
      { path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', family: 'Arial Unicode MS' }
    ]
  }
  return [
    { path: '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', family: 'Noto Color Emoji' },
    { path: '/usr/share/fonts/truetype/noto-color-emoji/NotoColorEmoji.ttf', family: 'Noto Color Emoji' }
  ]
}

export function findSystemEmojiFont(): SystemEmojiFont | null {
  return emojiFontCandidates().find((candidate) => existsSync(candidate.path)) ?? null
}

let emojiFamily: string | null = null
let emojiBytes: ArrayBuffer | null = null
let emojiSpec: SystemEmojiFont | null = null
let emojiActivated = false

/**
 * Wire the platform emoji font into BOTH sides of text rendering:
 * - draw: registered with Skia and appended to canvasFontSpec's fallback list
 *   (Skia shapes per run, so only missing glyphs use it — ASCII is untouched);
 * - metrics: setEmojiFont on the shared engine, so wrapping measures the emoji
 *   at the width it will actually draw.
 * Best-effort: with no system emoji font, behavior is exactly the pre-emoji
 * one (the glyph renders blank). Idempotent; must run before resolveLayout.
 */
export function activateSystemEmojiFont(): SystemEmojiFont | null {
  if (emojiActivated) return emojiSpec
  emojiActivated = true
  const spec = findSystemEmojiFont()
  if (!spec) return null
  try {
    const buffer = readFileSync(spec.path)
    if (!GlobalFonts.registerFromPath(spec.path, spec.family)) {
      logWarn(`[fonts] Skia rejected the emoji font at ${spec.path}`)
      return null
    }
    emojiFamily = spec.family
    emojiBytes = toArrayBuffer(buffer)
    emojiSpec = spec
    setEmojiFont(() => emojiBytes as ArrayBuffer)
    return spec
  } catch (error) {
    logWarn(`[fonts] could not activate emoji font ${spec.path}: ${(error as Error).message}`)
    return null
  }
}

/**
 * Emoji font bytes for the renderer's metrics (fetched once over the font
 * IPC). Empty when the platform has none — the caller treats that as "off".
 */
export function emojiFontBytes(): Uint8Array | null {
  activateSystemEmojiFont()
  return emojiBytes !== null ? new Uint8Array(emojiBytes) : null
}
