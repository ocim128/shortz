import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { isPlainObject, type Settings } from '../../shared/domain'
import type { DlQuality } from '../../shared/downloader/types'
import { atomicWriteFile, stripBom } from './fs-utils'

export function defaultSettings(): Settings {
  return {
    schemaVersion: 1,
    output: {
      dir: path.join(os.homedir(), 'Videos', 'ShortZ'),
      filenamePattern: '{name}_{yyyyMMdd}_{HHmm}'
    },
    encoder: { preferred: 'auto', crf: 18, fps: 30 },
    ffmpeg: { source: 'auto' },
    ui: { safeZonesDefault: true },
    downloads: {
      dir: path.join(os.homedir(), 'Videos', 'ShortZ', 'Downloads'),
      layout: 'by-author',
      filenameTemplate: '{id}',
      quality: 'best',
      resolveConcurrency: 4,
      downloadConcurrency: 3,
      fallback: 'off',
      writeSidecars: true
    }
  }
}

/**
 * Data dir: %APPDATA%/shortz on Windows, ~/.shortz elsewhere; SHORTZ_DATA_DIR
 * overrides (portable mode / tests). Presence of a `portable.flag` next to the
 * executable flips the root to ./data (the shell computes that and passes it in).
 */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHORTZ_DATA_DIR && env.SHORTZ_DATA_DIR.length > 0) {
    return path.resolve(env.SHORTZ_DATA_DIR)
  }
  if (process.platform === 'win32') {
    const appData = env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'shortz')
  }
  return path.join(os.homedir(), '.shortz')
}

export function settingsFilePath(dataDir: string): string {
  return path.join(dataDir, 'settings.json')
}

export function probeCacheDir(dataDir: string): string {
  return path.join(dataDir, 'cache', 'probes')
}

/**
 * Load settings, deep-merging over defaults. Unknown keys are preserved
 * (forward compatibility) — they survive the next save. Known enum/shape
 * fields are normalized to valid values so a hand-edited or corrupt
 * settings.json can never put an out-of-domain value behind the typed
 * Settings interface (callers stopped needing `as` casts for exactly this).
 */
export async function loadSettings(dataDir: string): Promise<Settings> {
  const file = settingsFilePath(dataDir)
  if (!existsSync(file)) return defaultSettings()
  try {
    const raw = JSON.parse(stripBom(await fs.readFile(file, 'utf8'))) as Record<string, unknown>
    return normalizeSettings(mergeSettings(defaultSettings(), raw))
  } catch {
    // Corrupt settings fall back to defaults rather than blocking the app.
    return defaultSettings()
  }
}

export async function saveSettings(settings: Settings, dataDir: string): Promise<void> {
  await atomicWriteFile(settingsFilePath(dataDir), `${JSON.stringify(settings, null, 2)}\n`)
}

function mergeSettings(defaults: Settings, raw: Record<string, unknown>): Settings {
  const merged = { ...defaults } as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(raw)) {
    const base = merged[key]
    if (isPlainObject(base) && isPlainObject(value)) {
      merged[key] = { ...base, ...value }
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged as unknown as Settings
}

// --- normalization (runtime guard for the typed enums) ------------------------

const ENCODER_PREFERRED = ['auto', 'libx264', 'h264_nvenc'] as const
const CRF_VALUES = [17, 18, 20, 23] as const
const FPS_VALUES = [30, 60, 'source'] as const
const FFMPEG_SOURCES = ['auto', 'system', 'bundled'] as const
const DL_LAYOUTS = ['by-author', 'by-date', 'flat'] as const
const DL_RESOLVE_CONCURRENCY = [1, 2, 3, 4, 5] as const
const DL_DOWNLOAD_CONCURRENCY = [1, 2, 3] as const
const DL_FALLBACKS = ['off', 'fxtwitter', 'auto'] as const

function oneOf<T extends readonly (string | number)[]>(
  values: T,
  value: unknown,
  fallback: T[number]
): T[number] {
  return (values as readonly unknown[]).includes(value) ? (value as T[number]) : fallback
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** Sanity bounds for a hand-edited `{ maxHeight }` quality. */
const MAX_HEIGHT_RANGE = { min: 144, max: 4320 } as const

/**
 * `DlQuality` is `'best' | 'worst' | { maxHeight }`; the object arm needs its
 * own guard or a hand-edited `{ maxHeight: "huge" }` would reach the selector.
 */
function normalizeQuality(value: unknown, fallback: DlQuality): DlQuality {
  if (value === 'best' || value === 'worst') return value
  if (isPlainObject(value)) {
    const height = value.maxHeight
    if (
      typeof height === 'number' &&
      Number.isFinite(height) &&
      height >= MAX_HEIGHT_RANGE.min &&
      height <= MAX_HEIGHT_RANGE.max
    ) {
      return { maxHeight: Math.round(height) }
    }
  }
  return fallback
}

/**
 * Clamp the typed fields of a merged Settings to their declared domains.
 * Anything out of domain falls back to the default for that field; unknown
 * extra keys pass through untouched.
 */
export function normalizeSettings(merged: Settings): Settings {
  const defaults = defaultSettings()
  // mergeSettings() only merges plain objects, so `downloads` can still be a
  // scalar from a hand-edited file — read it through a guard, never directly.
  const downloads: Record<string, unknown> = isPlainObject(merged.downloads)
    ? (merged.downloads as unknown as Record<string, unknown>)
    : {}
  return {
    ...merged,
    output: {
      dir: nonEmptyString(merged.output.dir, defaults.output.dir),
      filenamePattern: nonEmptyString(
        merged.output.filenamePattern,
        defaults.output.filenamePattern
      )
    },
    encoder: {
      preferred: oneOf(ENCODER_PREFERRED, merged.encoder.preferred, 'auto'),
      crf: oneOf(CRF_VALUES, merged.encoder.crf, defaults.encoder.crf),
      fps: oneOf(FPS_VALUES, merged.encoder.fps, defaults.encoder.fps)
    },
    ffmpeg: {
      source: oneOf(FFMPEG_SOURCES, merged.ffmpeg.source, 'auto')
    },
    ui: {
      safeZonesDefault:
        typeof merged.ui.safeZonesDefault === 'boolean'
          ? merged.ui.safeZonesDefault
          : defaults.ui.safeZonesDefault
    },
    downloads: {
      dir: nonEmptyString(downloads.dir, defaults.downloads.dir),
      layout: oneOf(DL_LAYOUTS, downloads.layout, defaults.downloads.layout),
      filenameTemplate: nonEmptyString(
        downloads.filenameTemplate,
        defaults.downloads.filenameTemplate
      ),
      quality: normalizeQuality(downloads.quality, defaults.downloads.quality),
      resolveConcurrency: oneOf(
        DL_RESOLVE_CONCURRENCY,
        downloads.resolveConcurrency,
        defaults.downloads.resolveConcurrency
      ),
      downloadConcurrency: oneOf(
        DL_DOWNLOAD_CONCURRENCY,
        downloads.downloadConcurrency,
        defaults.downloads.downloadConcurrency
      ),
      fallback: oneOf(DL_FALLBACKS, downloads.fallback, defaults.downloads.fallback),
      writeSidecars:
        typeof downloads.writeSidecars === 'boolean'
          ? downloads.writeSidecars
          : defaults.downloads.writeSidecars
    }
  }
}
