import { readFileSync } from 'node:fs'
import path from 'node:path'
import { GlobalFonts } from '@napi-rs/canvas'
import type { FontKey, FontLoader } from '../../shared/layout/text'

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
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/**
 * Synchronous fs-based font loader for opentype.js metrics — used by the CLI,
 * tests, Electron main and (via injected bytes) the renderer. src/shared stays
 * platform-free; only the host supplies this function.
 */
export function createFontBufferLoader(fontsDir: string): FontLoader {
  return (key: FontKey): ArrayBuffer => {
    if (!(key in FONT_FILES)) {
      throw new Error(`Unknown font key "${String(key)}"`)
    }
    return toArrayBuffer(readFileSync(fontFilePath(fontsDir, key)))
  }
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
    if (!ok) console.warn(`[fonts] could not register ${filePath}`)
    registered.add(mark)
  }
}

/** CSS-like font spec for @napi-rs/canvas ctx.font. */
export function canvasFontSpec(key: FontKey, fontSize: number): string {
  return `${FONT_WEIGHTS[key]} ${fontSize}px "${FONT_FAMILIES[key]}"`
}
