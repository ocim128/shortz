import path from 'node:path'
import fsp from 'node:fs/promises'
import { app } from 'electron'
import {
  loadSettings,
  probeCacheDir,
  saveSettings as saveSettingsDoc,
  settingsFilePath
} from '../core/store/settings'
import type { Settings } from '../shared/domain'

/**
 * Data-dir + resource paths for the main process (docs/technical/data-storage.md
 * §folder layout, project-structure.md §packaging notes).
 *
 * Root: portable mode (portable.flag) already redirects `app.getPath('userData')`
 * to `.\data\` next to the exe (src/main/index.ts applyPortableMode) — the core
 * store receives that root so its default (%APPDATA%\shortz) and the shell's
 * redirect both land in the same place. SHORTZ_DATA_DIR (core's documented env
 * override) wins for tests/harnesses.
 */
export function dataDir(): string {
  const env = process.env.SHORTZ_DATA_DIR
  if (env && env.length > 0) return path.resolve(env)
  return app.getPath('userData')
}

/** Dir containing `fonts/` + `templates/` for the render engine (asar-aware). */
export function resourcesDir(): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : app.getAppPath()
  return path.join(base, 'resources')
}

export function fontsDir(): string {
  return path.join(resourcesDir(), 'fonts')
}

export function projectsRoot(): string {
  return path.join(dataDir(), 'projects')
}

export function projectDir(projectId: string): string {
  // Belt-and-braces behind the IPC-boundary ULID check: an id must never
  // resolve outside the projects root (e.g. "../../evil").
  const root = path.resolve(projectsRoot())
  const dir = path.resolve(root, projectId)
  if (!dir.startsWith(root + path.sep)) {
    throw new Error(`Invalid project id: ${projectId}`)
  }
  return dir
}

export function projectFilePath(projectId: string): string {
  return path.join(projectDir(projectId), 'project.json')
}

export function thumbPath(projectId: string): string {
  return path.join(projectDir(projectId), 'thumb.jpg')
}

export function userTemplatesDir(): string {
  return path.join(dataDir(), 'templates', 'user')
}

export function probeCachesDir(): string {
  return probeCacheDir(dataDir())
}

/**
 * Downloader bookkeeping root: `state.json` + the poster cache live with the
 * app, while downloaded media lives in the user's folder
 * (docs/twitter-downloader/technical/storage-naming.md §1).
 */
export function downloadsDir(): string {
  return path.join(dataDir(), 'downloads')
}

export function dlPostersDir(): string {
  return path.join(downloadsDir(), 'cache', 'posters')
}

/**
 * Memoized settings — hot paths (every export/import/relink) call this, so
 * the memo skips the read+parse+merge. It is mtime-validated: settings.json
 * stays externally writable (tests, hand edits) and any write is picked up
 * on the next call, while the common case pays one stat instead of a read.
 */
let settingsMemo: { dir: string; value: Settings; mtimeMs: number | null } | null = null

async function settingsMtimeMs(dir: string): Promise<number | null> {
  const stat = await fsp.stat(settingsFilePath(dir)).catch(() => null)
  return stat?.mtimeMs ?? null
}

export async function currentSettings(): Promise<Settings> {
  const dir = dataDir()
  const mtimeMs = await settingsMtimeMs(dir)
  if (settingsMemo?.dir === dir && settingsMemo.mtimeMs === mtimeMs) return settingsMemo.value
  const value = await loadSettings(dir)
  settingsMemo = { dir, value, mtimeMs }
  return value
}

export async function saveCurrentSettings(settings: Settings): Promise<Settings> {
  const dir = dataDir()
  await saveSettingsDoc(settings, dir)
  // Re-load instead of echoing back: the store normalizes, so the memo stays
  // byte-for-byte identical to what a fresh process would read from disk.
  const value = await loadSettings(dir)
  settingsMemo = { dir, value, mtimeMs: await settingsMtimeMs(dir) }
  return value
}

/** Async so listing N projects never blocks the main-process event loop. */
export async function thumbAvailable(projectId: string): Promise<boolean> {
  const st = await fsp.stat(thumbPath(projectId)).catch(() => null)
  return !!(st && st.isFile())
}
