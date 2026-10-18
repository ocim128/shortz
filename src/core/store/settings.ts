import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { isPlainObject, type Settings } from '../../shared/domain'
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
    ui: { safeZonesDefault: true }
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
 * (forward compatibility) — they survive the next save.
 */
export async function loadSettings(dataDir: string): Promise<Settings> {
  const file = settingsFilePath(dataDir)
  if (!existsSync(file)) return defaultSettings()
  try {
    const raw = JSON.parse(stripBom(await fs.readFile(file, 'utf8'))) as Record<string, unknown>
    return mergeSettings(defaultSettings(), raw)
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
