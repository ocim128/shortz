import path from 'node:path'
import fsp from 'node:fs/promises'
import { app } from 'electron'
import { loadSettings, probeCacheDir, type ShortzSettings } from '../core/store/settings'

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

export async function currentSettings(): Promise<ShortzSettings> {
  return loadSettings(dataDir())
}

/** Async so listing N projects never blocks the main-process event loop. */
export async function thumbAvailable(projectId: string): Promise<boolean> {
  const st = await fsp.stat(thumbPath(projectId)).catch(() => null)
  return !!(st && st.isFile())
}
