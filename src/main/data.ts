import path from 'node:path'
import { app } from 'electron'
import { existsSync } from 'node:fs'
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
  return path.join(projectsRoot(), projectId)
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

export function thumbAvailable(projectId: string): boolean {
  return existsSync(thumbPath(projectId))
}
